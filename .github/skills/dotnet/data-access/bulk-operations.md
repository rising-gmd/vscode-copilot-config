# Bulk Operations
> Verified against: .NET 9 | C# 13 | EF Core 9.x | EFCore.BulkExtensions 8.x
> Last reviewed: 2026-02-22

## The Law
Use `ExecuteUpdateAsync` / `ExecuteDeleteAsync` for set-based bulk mutations and `BulkInsertAsync` for bulk inserts — never loop `SaveChangesAsync` inside a `foreach`.

## Why This Kills You At Scale
Inserting 10,000 messages with a `foreach` + `SaveChangesAsync` generates 10,000 individual `INSERT` statements — at 100ms network round-trip to SQL Server, that is 16 minutes for what a single bulk insert completes in 200ms. A background job that marks 50,000 messages as read via a loop holds a DB connection for minutes, blocks other operations, and exhausts the connection pool. This is not a corner case — any import, migration, or batch job will hit this.

## The Pattern

```csharp
#nullable enable
using Microsoft.EntityFrameworkCore;
using EFCore.BulkExtensions;

// ✅ Correct: ExecuteUpdateAsync — set-based UPDATE, single SQL statement
public async Task MarkConversationMessagesReadAsync(
    Guid conversationId, Guid userId, CancellationToken ct)
{
    await _context.Messages
        .Where(m => m.ConversationId == conversationId
                 && m.SenderId != userId
                 && !m.IsRead
                 && !m.IsDeleted)
        .ExecuteUpdateAsync(s => s
            .SetProperty(m => m.IsRead, true)
            .SetProperty(m => m.ReadAt, DateTime.UtcNow), ct);
    // One SQL UPDATE statement regardless of how many rows match
}

// ✅ Correct: ExecuteDeleteAsync — set-based DELETE, single SQL statement
public async Task DeleteExpiredSessionsAsync(DateTime expiryThreshold, CancellationToken ct)
{
    await _context.UserSessions
        .Where(s => s.RefreshTokenExpiry < expiryThreshold)
        .ExecuteDeleteAsync(ct);
}

// ✅ Correct: BulkInsertAsync — batch insert without row-by-row round trips
public async Task ImportMessagesAsync(
    IReadOnlyList<Message> messages, CancellationToken ct)
{
    const int batchSize = 1000;

    for (int i = 0; i < messages.Count; i += batchSize)
    {
        var batch = messages.Skip(i).Take(batchSize).ToList();
        // Single SQL bulk insert per batch — SqlBulkCopy under the hood
        await _context.BulkInsertAsync(batch, cancellationToken: ct);
    }
}

// ✅ Correct: AddRange for moderate volumes (< 1000 rows) without EFCore.BulkExtensions
public async Task CreateInitialMessagesAsync(
    IReadOnlyList<Message> messages, CancellationToken ct)
{
    // EF Core batches AddRange into multi-row INSERT statements
    // More efficient than one-by-one but less than BulkInsertAsync
    _context.Messages.AddRange(messages);
    await _context.SaveChangesAsync(ct);
}

// ❌ Wrong: SaveChangesAsync in a loop — N round trips to DB
public async Task MarkReadInsecureAsync(List<Guid> messageIds, CancellationToken ct)
{
    foreach (var id in messageIds)
    {
        var message = await _context.Messages.FindAsync([id], ct);
        if (message is null) continue;
        message.IsRead = true;
        await _context.SaveChangesAsync(ct); // Network round trip PER message
    }
    // 10,000 messages = 10,000 round trips = minutes of execution
}

// ✅ Correct: streaming + batched processing for large result sets
public async Task ProcessLargeDatasetAsync(CancellationToken ct)
{
    // AsAsyncEnumerable() streams results — doesn't load all into memory
    var batch = new List<Message>(500);

    await foreach (var message in _context.Messages
        .AsNoTracking()
        .Where(m => !m.IsProcessed)
        .AsAsyncEnumerable()
        .WithCancellation(ct))
    {
        message.IsProcessed = true;
        batch.Add(message);

        if (batch.Count >= 500)
        {
            await _context.BulkUpdateAsync(batch, cancellationToken: ct);
            batch.Clear();
        }
    }

    if (batch.Count > 0)
        await _context.BulkUpdateAsync(batch, cancellationToken: ct);
}
```

## The Trap

```csharp
// A senior developer uses ExecuteUpdateAsync for bulk operations.
// Correct. Ships.
// The trap: ExecuteUpdateAsync and ExecuteDeleteAsync bypass interceptors,
// audit logging, domain events, and the change tracker entirely.

// If you have an interceptor that fires on SaveChangesAsync for audit logging:
public sealed class AuditInterceptor : SaveChangesInterceptor
{
    public override async ValueTask<InterceptionResult<int>> SavingChangesAsync(...)
    {
        // This never fires for ExecuteUpdateAsync / ExecuteDeleteAsync
        // Your audit log has silent gaps for bulk operations
    }
}

// Fix 1: manually audit before the bulk operation
public async Task DeleteExpiredSessionsWithAuditAsync(DateTime threshold, CancellationToken ct)
{
    var count = await _context.UserSessions
        .CountAsync(s => s.RefreshTokenExpiry < threshold, ct);

    _auditLogger.LogBulkOperation("DELETE_EXPIRED_SESSIONS", count, threshold);

    await _context.UserSessions
        .Where(s => s.RefreshTokenExpiry < threshold)
        .ExecuteDeleteAsync(ct);
}

// Fix 2: for entities that MUST fire domain events on bulk change (e.g., sending SignalR notifications),
// load IDs first, then use ExecuteUpdateAsync, then dispatch events manually:
public async Task MarkReadWithNotificationsAsync(
    Guid conversationId, Guid userId, CancellationToken ct)
{
    // Get affected IDs before the bulk update
    var affectedIds = await _context.Messages
        .Where(m => m.ConversationId == conversationId && !m.IsRead)
        .Select(m => m.Id)
        .ToListAsync(ct);

    await _context.Messages
        .Where(m => m.ConversationId == conversationId && !m.IsRead)
        .ExecuteUpdateAsync(s => s.SetProperty(m => m.IsRead, true), ct);

    // Manually dispatch the domain event with known IDs
    await _mediator.Publish(new MessagesReadEvent(conversationId, userId, affectedIds), ct);
}
```

## The Exception
For single-entity mutations within a business transaction (create one conversation, update one user profile), `SaveChangesAsync` is correct — the overhead of one round trip is negligible and you get change tracking, interceptors, and domain events for free. The bulk operation rules apply when the number of affected rows is variable and potentially large — not for fixed single-entity operations.

## Before You Merge
- Are all set-based updates using `ExecuteUpdateAsync` — not a `foreach` over loaded entities?
- Are bulk inserts of more than 100 rows using `BulkInsertAsync` or at minimum `AddRange` + single `SaveChangesAsync`?
- Do bulk operations that bypass interceptors have explicit audit logging before execution?
- Are large result sets streamed with `AsAsyncEnumerable()` — not fully loaded with `ToListAsync()`?
- Is there a batch size cap on `BulkInsertAsync` calls — not inserting millions of rows in a single operation?
