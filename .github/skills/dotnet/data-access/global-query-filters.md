# Global Query Filters
> Verified against: .NET 9 | C# 13 | EF Core 9.x
> Last reviewed: 2026-02-22

## The Law
Use global query filters for cross-cutting data constraints (soft delete, multi-tenancy, user scoping) — and document every `IgnoreQueryFilters()` usage with a comment explaining the intentional bypass.

## Why This Kills You At Scale
A multi-tenant app without global query filters relies on every developer manually adding `WHERE TenantId = @tenantId` to every query. One missed query returns another tenant's data — a catastrophic data breach. At 100k users across multiple tenants, the probability of a missing filter in a rushed feature approaches 100%. Global filters enforce the constraint at the EF Core infrastructure layer — impossible to bypass accidentally.

## The Pattern

```csharp
#nullable enable
using Microsoft.EntityFrameworkCore;

// ✅ Correct: multi-tenant base entity
public abstract class TenantEntity
{
    public Guid TenantId { get; set; }
    public bool IsDeleted { get; set; }
}

// ✅ Correct: DbContext with global filters — scoped per request via ITenantContext
public class AppDbContext(
    DbContextOptions<AppDbContext> options,
    ITenantContext tenantContext) : DbContext(options)
{
    public DbSet<Conversation> Conversations => Set<Conversation>();
    public DbSet<Message> Messages => Set<Message>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        base.OnModelCreating(modelBuilder);

        // ✅ Apply filters to all TenantEntity descendants automatically
        foreach (var entityType in modelBuilder.Model.GetEntityTypes())
        {
            if (!typeof(TenantEntity).IsAssignableFrom(entityType.ClrType))
                continue;

            // Capture tenantContext in closure — evaluated per query using current request's tenant
            var tenantId = tenantContext.TenantId;

            modelBuilder.Entity(entityType.ClrType).HasQueryFilter(
                BuildCombinedFilter(entityType.ClrType, tenantContext));
        }
    }

    private static System.Linq.Expressions.LambdaExpression BuildCombinedFilter(
        Type entityType, ITenantContext tenantContext)
    {
        var param = System.Linq.Expressions.Expression.Parameter(entityType, "e");

        // Filter 1: tenant isolation
        var tenantProp = System.Linq.Expressions.Expression.Property(param, "TenantId");
        var tenantFilter = System.Linq.Expressions.Expression.Equal(
            tenantProp,
            System.Linq.Expressions.Expression.Property(
                System.Linq.Expressions.Expression.Constant(tenantContext),
                nameof(ITenantContext.TenantId)));

        // Filter 2: soft delete
        var deletedProp = System.Linq.Expressions.Expression.Property(param, "IsDeleted");
        var deleteFilter = System.Linq.Expressions.Expression.Not(deletedProp);

        // Combined: TenantId = @current AND IsDeleted = 0
        var combined = System.Linq.Expressions.Expression.AndAlso(tenantFilter, deleteFilter);

        return System.Linq.Expressions.Expression.Lambda(combined, param);
    }
}

// ✅ Correct: simpler per-entity configuration (preferred for readability)
public class ConversationConfiguration : IEntityTypeConfiguration<Conversation>
{
    private readonly ITenantContext _tenantContext;

    public ConversationConfiguration(ITenantContext tenantContext)
        => _tenantContext = tenantContext;

    public void Configure(EntityTypeBuilder<Conversation> builder)
    {
        // Both filters combined — any query against Conversations is automatically scoped
        builder.HasQueryFilter(c =>
            c.TenantId == _tenantContext.TenantId && !c.IsDeleted);
    }
}

// ✅ Correct: intentional bypass for admin/system operations — documented
public async Task<List<Conversation>> GetAllTenantsConversationsForAuditAsync(CancellationToken ct)
{
    // IgnoreQueryFilters: admin audit endpoint — intentionally crosses tenant boundary
    // Caller: AdminAuditService only — protected by [Authorize(Roles = "SystemAdmin")]
    return await _context.Conversations
        .IgnoreQueryFilters()
        .AsNoTracking()
        .OrderByDescending(c => c.CreatedAt)
        .ToListAsync(ct);
}

// ❌ Wrong: manual tenant filter on every query — one miss = cross-tenant leak
public async Task<List<Conversation>> GetInsecureAsync(Guid tenantId, CancellationToken ct)
{
    return await _context.Conversations
        .Where(c => c.TenantId == tenantId) // Manual — next developer forgets this
        .ToListAsync(ct);
}
```

## The Trap

```csharp
// A senior developer sets up global query filters correctly.
// Single-tenant app for now — just soft delete filter.
// Multi-tenancy is planned for "later."
// Ships.

// The trap: global filters compose when multiple are applied.
// When multi-tenancy is added 6 months later, the new filter
// AND's with the existing soft-delete filter — correct behavior.
// BUT: any existing IgnoreQueryFilters() calls now bypass BOTH filters.

// Before multi-tenancy:
// IgnoreQueryFilters() bypasses: IsDeleted filter — acceptable for admin

// After multi-tenancy added:
// IgnoreQueryFilters() bypasses: IsDeleted AND TenantId — data breach

// The fix: document every IgnoreQueryFilters() with WHICH filter it's bypassing
// and audit all of them when a new filter is added.

// Also: use separate filter methods or partial queries to bypass individual filters:
// EF Core doesn't support bypassing individual query filters — it's all or nothing.
// Design workaround: use a different DbContext or DbSet for cross-tenant queries:

// services.AddScoped<AdminDbContext>(); // No tenant filter, restricted to Admin role
// services.AddScoped<AppDbContext>();   // Tenant filter always on

// This is the architecture pattern that scales safely for multi-tenancy.
```

## The Exception
System-level entities that span tenants by design (TenantConfiguration, SystemSettings, PricingPlans) must not have tenant query filters — they are genuinely shared data. Use a separate `SystemEntity` base class without the TenantId property, and define filters only on `TenantEntity` descendants. Never put tenant filter on system tables, and never put system data in tenant-scoped tables.

## Before You Merge
- Is every `IEntityTypeConfiguration` for multi-tenant entities configuring `HasQueryFilter` with both the tenant and soft-delete predicates?
- Is every `IgnoreQueryFilters()` call accompanied by a comment naming WHICH filter is being bypassed and WHY?
- Is the `ITenantContext` injected into `AppDbContext` as a scoped service — not as a singleton that would share tenant state across requests?
- Are system-level cross-tenant entities using a separate base class that does NOT have the tenant query filter?
- Has an architecture test been added to verify every `TenantEntity` descendant has a configured query filter?
