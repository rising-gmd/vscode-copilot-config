# Repository Pattern
> Verified against: .NET 9 | C# 13 | EF Core 9.x
> Last reviewed: 2026-02-22

## The Law
Define repository interfaces in the Domain layer with domain-meaningful methods — never expose `IQueryable<T>` from a repository or let callers build queries outside the repository boundary.

## Why This Kills You At Scale
A repository that returns `IQueryable<T>` leaks the data access implementation — callers add `.Where()`, `.Include()`, `.OrderBy()` outside the repository, scattering query logic across the codebase. At 100k users, a performance regression requires hunting through 40 service files to find all callers that built queries on the leaked `IQueryable`. You cannot add an index and be confident it helps without reading every caller. Query optimisation becomes archaeology.

## The Pattern

```csharp
#nullable enable
using Microsoft.EntityFrameworkCore;

// ✅ Correct: domain-meaningful interface in Domain layer — no EF Core references
public interface IConversationRepository
{
    Task<Conversation?> GetByIdAsync(Guid id, CancellationToken ct = default);
    Task<Conversation?> GetByIdWithParticipantsAsync(Guid id, CancellationToken ct = default);
    Task<bool> IsUserMemberAsync(Guid conversationId, Guid userId, CancellationToken ct = default);
    Task<Conversation> GetOrCreateDirectAsync(Guid userId1, Guid userId2, CancellationToken ct = default);
    Task AddAsync(Conversation conversation, CancellationToken ct = default);
}

// ✅ Correct: implementation in Infrastructure layer — EF Core lives here
public sealed class ConversationRepository(AppDbContext context) : IConversationRepository
{
    public async Task<Conversation?> GetByIdAsync(Guid id, CancellationToken ct)
        => await context.Conversations
            .AsNoTracking()
            .FirstOrDefaultAsync(c => c.Id == id && !c.IsDeleted, ct);

    public async Task<Conversation?> GetByIdWithParticipantsAsync(Guid id, CancellationToken ct)
        => await context.Conversations
            .Include(c => c.Participants).ThenInclude(p => p.User)
            .FirstOrDefaultAsync(c => c.Id == id && !c.IsDeleted, ct);

    public async Task<bool> IsUserMemberAsync(
        Guid conversationId, Guid userId, CancellationToken ct)
        => await context.ConversationParticipants
            .AsNoTracking()
            .AnyAsync(p => p.ConversationId == conversationId
                        && p.UserId == userId, ct);

    public async Task<Conversation> GetOrCreateDirectAsync(
        Guid userId1, Guid userId2, CancellationToken ct)
    {
        var existing = await context.Conversations
            .Include(c => c.Participants)
            .Where(c => !c.IsGroup && !c.IsDeleted)
            .Where(c => c.Participants.Count == 2)
            .Where(c => c.Participants.Any(p => p.UserId == userId1))
            .Where(c => c.Participants.Any(p => p.UserId == userId2))
            .FirstOrDefaultAsync(ct);

        if (existing is not null) return existing;

        var conversation = new Conversation
        {
            IsGroup = false,
            LastActivity = DateTime.UtcNow,
            Participants =
            [
                new ConversationParticipant { UserId = userId1 },
                new ConversationParticipant { UserId = userId2 }
            ]
        };

        await context.Conversations.AddAsync(conversation, ct);
        return conversation;
    }

    public async Task AddAsync(Conversation conversation, CancellationToken ct)
        => await context.Conversations.AddAsync(conversation, ct);
}

// ✅ Correct: generic base for shared CRUD — kept thin
public abstract class Repository<TEntity>(AppDbContext context)
    where TEntity : BaseEntity
{
    protected readonly AppDbContext Context = context;
    protected readonly DbSet<TEntity> DbSet = context.Set<TEntity>();

    public async Task<TEntity?> GetByIdAsync(Guid id, CancellationToken ct = default)
        => await DbSet.FindAsync([id], ct);

    public async Task AddAsync(TEntity entity, CancellationToken ct = default)
        => await DbSet.AddAsync(entity, ct);

    public async Task<bool> ExistsAsync(Guid id, CancellationToken ct = default)
        => await DbSet.AnyAsync(e => e.Id == id, ct);
}

// ❌ Wrong: IQueryable leak — callers build queries outside repository
public interface ILeakyRepository<T>
{
    IQueryable<T> GetAll(); // Callers now own the query — repository boundary broken
}

// ❌ Wrong: generic repository with no domain-specific methods
// Forces callers to write LINQ everywhere — same as no repository
public interface IGenericRepository<T>
{
    Task<IReadOnlyList<T>> GetAllAsync(CancellationToken ct);
    // No IsUserMemberAsync, no GetOrCreateDirectAsync — callers must duplicate this logic
}
```

## The Trap

```csharp
// A senior developer builds a clean repository with domain methods.
// All looks correct. Integration tests pass.
// The trap: the repository SaveChanges anti-pattern.

public sealed class BrokenConversationRepository(AppDbContext context)
{
    public async Task<Conversation> GetOrCreateDirectAsync(
        Guid userId1, Guid userId2, CancellationToken ct)
    {
        var existing = await context.Conversations
            .FirstOrDefaultAsync(c => !c.IsGroup, ct);

        if (existing is not null) return existing;

        var conversation = new Conversation { IsGroup = false };
        await context.AddAsync(conversation, ct);

        // BUG: SaveChanges inside the repository — breaks Unit of Work
        // Caller expects to control when the transaction commits.
        // If the caller's outer operation fails after this, the conversation is persisted
        // but the caller's other changes are rolled back — inconsistent state.
        await context.SaveChangesAsync(ct);

        return conversation;
    }
}

// Rule: repositories NEVER call SaveChanges/SaveChangesAsync.
// Only IUnitOfWork.SaveChangesAsync() is called, from the service layer,
// after ALL repository operations in the logical unit are complete.
```

## The Exception
Read-model repositories for CQRS query handlers can return DTOs directly from Dapper queries and do not need to follow the entity-based repository pattern — they are purpose-built for specific queries, have no `SaveChanges` involvement, and can be as query-specific as needed. The IQueryable leak rule still applies — do not return `IQueryable` even from read-model repositories, because it makes the query boundary ambiguous.

## Before You Merge
- Are repository interfaces defined in Domain or Application layer with zero EF Core references?
- Does every repository method have a domain-meaningful name — not just `GetAll()` or `Find()`?
- Does any repository method call `SaveChangesAsync()` — if yes, remove it immediately?
- Are all `IQueryable<T>` return types replaced with `Task<IReadOnlyList<T>>` or `Task<T?>`?
- Does the generic base repository stay thin — with domain-specific methods only in concrete repositories?
