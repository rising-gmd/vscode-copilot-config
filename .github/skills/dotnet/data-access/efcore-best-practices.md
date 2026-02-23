# EF Core Best Practices
> Verified against: .NET 9 | C# 13 | EF Core 9.x
> Last reviewed: 2026-02-22

## The Law
Project to DTOs with `Select()` and use `AsNoTracking()` on every read-only query — never load full entities when you only need a subset of columns.

## Why This Kills You At Scale
A `GetConversations()` endpoint loads full `Message` entities including body text, attachments metadata, and all navigation properties — at 100k users each with 500 messages, a single list endpoint transfers gigabytes of data from DB to app server per minute. The query runs in 40ms in development with 10 rows. It times out in production with 50,000 rows because nobody measured with realistic data.

## The Pattern

```csharp
#nullable enable
using Microsoft.EntityFrameworkCore;

public sealed class ConversationRepository(AppDbContext context)
{
    // ✅ Correct: project to DTO at DB level — only needed columns cross the wire
    public async Task<IReadOnlyList<ConversationSummaryDto>> GetForUserAsync(
        Guid userId,
        CancellationToken ct)
    {
        return await context.ConversationParticipants
            .AsNoTracking() // No change tracking — read-only path
            .Where(p => p.UserId == userId)
            .Select(p => new ConversationSummaryDto
            {
                ConversationId = p.ConversationId,
                // Only the columns the UI actually needs
                LastMessageText = p.Conversation.Messages
                    .OrderByDescending(m => m.SentAt)
                    .Select(m => m.Content)
                    .FirstOrDefault(),
                LastActivity = p.Conversation.LastActivity,
                UnreadCount = p.Conversation.Messages
                    .Count(m => m.SentAt > p.LastReadAt && m.SenderId != userId),
            })
            .OrderByDescending(x => x.LastActivity)
            .ToListAsync(ct);
    }

    // ✅ Correct: load full entity only when you will mutate it
    public async Task<Conversation?> GetForUpdateAsync(Guid id, CancellationToken ct)
    {
        // No AsNoTracking — EF must track this for SaveChanges to work
        return await context.Conversations
            .Include(c => c.Participants)
            .FirstOrDefaultAsync(c => c.Id == id, ct);
    }

    // ✅ Correct: bulk update without loading entities — EF Core 7+
    public async Task MarkAllAsReadAsync(Guid conversationId, Guid userId, CancellationToken ct)
    {
        await context.Messages
            .Where(m => m.ConversationId == conversationId
                     && m.SenderId != userId
                     && m.ReadAt == null)
            .ExecuteUpdateAsync(s => s
                .SetProperty(m => m.ReadAt, DateTime.UtcNow), ct);
    }

    // ✅ Correct: AsSplitQuery when including multiple collections
    public async Task<Conversation?> GetWithAllDetailsAsync(Guid id, CancellationToken ct)
    {
        return await context.Conversations
            .AsSplitQuery() // Prevents cartesian explosion from multiple Includes
            .Include(c => c.Participants).ThenInclude(p => p.User)
            .Include(c => c.Messages.OrderByDescending(m => m.SentAt).Take(50))
            .FirstOrDefaultAsync(c => c.Id == id, ct);
    }

    // ❌ Wrong: loading full entity for read — wastes bandwidth and memory
    public async Task<IReadOnlyList<Conversation>> GetAllInsecureAsync(
        Guid userId,
        CancellationToken ct)
    {
        return await context.Conversations
            .Include(c => c.Messages)      // Loads ALL messages for ALL conversations
            .Include(c => c.Participants)
            .Where(c => c.Participants.Any(p => p.UserId == userId))
            .ToListAsync(ct); // Could be gigabytes
    }

    // ❌ Wrong: AsNoTracking then SaveChanges — silent data loss
    public async Task UpdateInsecureAsync(Guid id, CancellationToken ct)
    {
        var conv = await context.Conversations
            .AsNoTracking()
            .FirstOrDefaultAsync(c => c.Id == id, ct);

        if (conv is null) return;
        conv.LastActivity = DateTime.UtcNow;
        await context.SaveChangesAsync(ct); // Does nothing — entity not tracked
    }
}
```

## The Trap

```csharp
// A senior developer correctly uses AsNoTracking and Select projections.
// Performance is excellent. Ships.
// New feature: "show if conversation has unread messages" — added as a bool property.

public async Task<IReadOnlyList<ConversationSummaryDto>> GetForUserAsync(Guid userId, CancellationToken ct)
{
    var conversations = await context.Conversations
        .AsNoTracking()
        .Where(c => c.Participants.Any(p => p.UserId == userId))
        .ToListAsync(ct); // Loads entities into memory

    // BUG: HasUnread is computed in C# — but it triggers lazy loading of Messages
    // if LazyLoadingProxies are enabled. Each conversation fires a separate DB query.
    // 100 conversations = 101 queries. Works fine in dev. Destroys production.
    return conversations
        .Select(c => new ConversationSummaryDto
        {
            HasUnread = c.Messages.Any(m => m.ReadAt == null) // N+1 here
        })
        .ToList();
}

// Fix: compute HasUnread in the EF Select projection — stays in SQL
public async Task<IReadOnlyList<ConversationSummaryDto>> GetForUserFixedAsync(Guid userId, CancellationToken ct)
{
    return await context.ConversationParticipants
        .AsNoTracking()
        .Where(p => p.UserId == userId)
        .Select(p => new ConversationSummaryDto
        {
            HasUnread = p.Conversation.Messages
                .Any(m => m.ReadAt == null && m.SenderId != userId) // In SQL — one query
        })
        .ToListAsync(ct);
}
```

## The Exception
Loading full tracked entities is correct when: (1) you are about to mutate the entity and call `SaveChanges`, (2) you need to pass the entity to a domain method that enforces business rules on its properties, or (3) you are working with a small bounded set (single entity by ID). The projection rule applies to list queries and read-only endpoints — not to every query in the system.

## Before You Merge
- Does every list/collection query use `AsNoTracking()` and project with `Select()`?
- Does every query that loads for mutation omit `AsNoTracking()`?
- Are multiple `Include()` calls on collection navigations using `AsSplitQuery()`?
- Are bulk updates using `ExecuteUpdateAsync()` — not load-modify-save loops?
- Has the generated SQL been inspected in development logs for N+1 patterns?
