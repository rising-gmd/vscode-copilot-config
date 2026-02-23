# Soft Delete Pattern
> Verified against: .NET 9 | C# 13 | EF Core 9.x
> Last reviewed: 2026-02-22

## The Law
Apply soft delete via a global query filter on a base entity — never scatter `WHERE IsDeleted = 0` conditions across individual queries.

## Why This Kills You At Scale
A single forgotten `WHERE IsDeleted = 0` clause in a Dapper query or raw SQL exposes deleted records to users — deleted messages reappear, deactivated users show in search, private data is leaked. At 100k users with GDPR obligations, deleted user data appearing in any context is a data breach. Manual `IsDeleted` filtering across hundreds of queries guarantees at least one will be missed.

## The Pattern

```csharp
#nullable enable
using Microsoft.EntityFrameworkCore;

// ✅ Correct: base entity with soft delete fields
public abstract class SoftDeletableEntity
{
    public bool IsDeleted { get; set; }
    public DateTime? DeletedAt { get; set; }
    public Guid? DeletedByUserId { get; set; }
}

public class Message : SoftDeletableEntity
{
    public Guid Id { get; set; }
    public string Content { get; set; } = string.Empty;
    public Guid ConversationId { get; set; }
}

// ✅ Correct: global query filter in DbContext — applied to EVERY query automatically
public class AppDbContext : DbContext
{
    public DbSet<Message> Messages => Set<Message>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        // Apply to all entities that inherit SoftDeletableEntity
        foreach (var entityType in modelBuilder.Model.GetEntityTypes())
        {
            if (typeof(SoftDeletableEntity).IsAssignableFrom(entityType.ClrType))
            {
                modelBuilder.Entity(entityType.ClrType)
                    .HasQueryFilter(
                        System.Linq.Expressions.Expression.Lambda(
                            System.Linq.Expressions.Expression.Equal(
                                System.Linq.Expressions.Expression.Property(
                                    System.Linq.Expressions.Expression.Parameter(entityType.ClrType, "e"),
                                    "IsDeleted"),
                                System.Linq.Expressions.Expression.Constant(false)),
                            System.Linq.Expressions.Expression.Parameter(entityType.ClrType, "e")));
            }
        }
    }
}

// ✅ Correct: per-entity configuration (preferred — explicit and readable)
public class MessageConfiguration : IEntityTypeConfiguration<Message>
{
    public void Configure(EntityTypeBuilder<Message> builder)
    {
        builder.HasQueryFilter(m => !m.IsDeleted);
        builder.HasIndex(m => m.IsDeleted); // Index for filter performance
    }
}

// ✅ Correct: soft delete in service — never call DbContext.Remove()
public async Task DeleteMessageAsync(Guid messageId, Guid actorId, CancellationToken ct)
{
    await _context.Messages
        .Where(m => m.Id == messageId)
        .ExecuteUpdateAsync(s => s
            .SetProperty(m => m.IsDeleted, true)
            .SetProperty(m => m.DeletedAt, DateTime.UtcNow)
            .SetProperty(m => m.DeletedByUserId, actorId), ct);
}

// ✅ Correct: admin query — bypass global filter explicitly with comment
public async Task<List<Message>> GetDeletedMessagesForAuditAsync(
    Guid conversationId, CancellationToken ct)
{
    return await _context.Messages
        .IgnoreQueryFilters()          // Explicit bypass — makes intent obvious in code review
        .Where(m => m.ConversationId == conversationId && m.IsDeleted)
        .AsNoTracking()
        .ToListAsync(ct);
}

// ❌ Wrong: manual IsDeleted filter — one miss = data leak
public async Task<List<Message>> GetInsecureAsync(Guid conversationId, CancellationToken ct)
{
    return await _context.Messages
        // No global filter + no manual filter = deleted messages returned
        .Where(m => m.ConversationId == conversationId)
        .ToListAsync(ct);
}
```

## The Trap

```csharp
// A senior developer sets up global query filters correctly.
// EF Core queries are all protected. Ships.
// The trap: Dapper queries bypass EF Core entirely — no global filter applies.

public sealed class DapperMessageRepository(IDbConnectionFactory factory)
{
    public async Task<IEnumerable<MessageDto>> GetByConversationAsync(
        Guid conversationId, CancellationToken ct)
    {
        using var conn = factory.CreateConnection();
        // BUG: Global query filter does NOT apply to Dapper
        // Deleted messages are returned silently
        return await conn.QueryAsync<MessageDto>(
            new CommandDefinition(
                "SELECT Id, Content FROM Messages WHERE ConversationId = @ConversationId",
                new { ConversationId = conversationId },
                cancellationToken: ct));
    }

    // Fix: IsDeleted must always be explicit in Dapper queries
    public async Task<IEnumerable<MessageDto>> GetByConversationSafeAsync(
        Guid conversationId, CancellationToken ct)
    {
        using var conn = factory.CreateConnection();
        return await conn.QueryAsync<MessageDto>(
            new CommandDefinition(
                // Always explicit in Dapper — no framework to fall back on
                "SELECT Id, Content FROM Messages WHERE ConversationId = @ConversationId AND IsDeleted = 0",
                new { ConversationId = conversationId },
                cancellationToken: ct));
    }
}

// Rule: create a SQL snippet or Dapper convention document that says:
// "All Dapper queries on soft-deletable tables MUST include AND IsDeleted = 0"
// And enforce with an architecture test scanning Dapper SQL strings.
```

## The Exception
Physical delete is correct for: compliance-driven data erasure (GDPR right to erasure where the data cannot remain anywhere), high-volume ephemeral data (session tokens, OTPs, temporary files) where storage cost of retaining deleted records is significant, and junction table rows (message reads, likes) where historical tracking adds no value. Soft delete is for business entities with audit requirements — not for every table.

## Before You Merge
- Is `HasQueryFilter(e => !e.IsDeleted)` configured for every soft-deletable entity in `IEntityTypeConfiguration`?
- Are all Dapper queries on soft-deletable tables explicitly including `AND IsDeleted = 0`?
- Are all delete operations in the service layer using `ExecuteUpdateAsync` to set `IsDeleted = true` — never `DbContext.Remove()`?
- Does every `IgnoreQueryFilters()` usage have a code comment explaining why the bypass is intentional?
- Is there an index on `IsDeleted` (or a filtered index `WHERE IsDeleted = 0`) on high-traffic tables?
