# Keyset Pagination
> Verified against: .NET 9 | C# 13 | EF Core 9.x | Dapper 2.x
> Last reviewed: 2026-02-22

## The Law
Use keyset (cursor) pagination for large, frequently-updated datasets — never offset pagination on tables with more than 10,000 rows that users scroll through continuously.

## Why This Kills You At Scale
`OFFSET 50000 ROWS FETCH NEXT 20 ROWS ONLY` forces SQL Server to read and discard 50,000 rows before returning your 20 — at page 2,500 of a chat history, every scroll event causes a full table scan equivalent. At 100k users each loading page 100 of their message history, your SQL Server CPU hits 100% and response times spike from 5ms to 5000ms. Offset pagination also skips and duplicates records when new messages are inserted between page loads.

## The Pattern

```csharp
#nullable enable
using Microsoft.EntityFrameworkCore;

// ✅ Correct: keyset pagination — cursor is the last seen ID + sort column value
public sealed record MessageCursor(DateTime SentAt, Guid Id);

public async Task<PagedResult<MessageDto>> GetMessagesAsync(
    Guid conversationId,
    MessageCursor? cursor,          // null = first page
    int pageSize,
    CancellationToken ct)
{
    pageSize = Math.Clamp(pageSize, 1, 100); // Enforce server-side limit

    var query = _context.Messages
        .AsNoTracking()
        .Where(m => m.ConversationId == conversationId && !m.IsDeleted);

    // ✅ Keyset: WHERE (SentAt, Id) < (cursor.SentAt, cursor.Id) — no OFFSET
    if (cursor is not null)
    {
        query = query.Where(m =>
            m.SentAt < cursor.SentAt ||
            (m.SentAt == cursor.SentAt && m.Id < cursor.Id));
    }

    var messages = await query
        .OrderByDescending(m => m.SentAt)
        .ThenByDescending(m => m.Id)        // Tiebreaker — Id makes sort deterministic
        .Take(pageSize + 1)                 // Take one extra to detect if there's a next page
        .Select(m => new MessageDto
        {
            Id = m.Id,
            Content = m.Content,
            SentAt = m.SentAt,
            SenderUsername = m.Sender.Username
        })
        .ToListAsync(ct);

    var hasNextPage = messages.Count > pageSize;
    if (hasNextPage) messages.RemoveAt(messages.Count - 1);

    // ✅ Return cursor pointing to last item — client sends this back on next request
    MessageCursor? nextCursor = null;
    if (hasNextPage && messages.Count > 0)
    {
        var last = messages[^1];
        nextCursor = new MessageCursor(last.SentAt, last.Id);
    }

    return new PagedResult<MessageDto>(messages, nextCursor);
}

// ✅ Correct: Dapper equivalent — same keyset logic in raw SQL
public async Task<IEnumerable<MessageDto>> GetMessagesDapperAsync(
    Guid conversationId,
    DateTime? cursorSentAt,
    Guid? cursorId,
    int pageSize,
    CancellationToken ct)
{
    using var conn = _factory.CreateConnection();

    var sql = cursorSentAt is null
        ? """
            SELECT TOP (@PageSize) m.Id, m.Content, m.SentAt, u.Username AS SenderUsername
            FROM Messages m
            INNER JOIN Users u ON u.Id = m.SenderId
            WHERE m.ConversationId = @ConversationId AND m.IsDeleted = 0
            ORDER BY m.SentAt DESC, m.Id DESC
          """
        : """
            SELECT TOP (@PageSize) m.Id, m.Content, m.SentAt, u.Username AS SenderUsername
            FROM Messages m
            INNER JOIN Users u ON u.Id = m.SenderId
            WHERE m.ConversationId = @ConversationId AND m.IsDeleted = 0
              AND (m.SentAt < @CursorSentAt OR (m.SentAt = @CursorSentAt AND m.Id < @CursorId))
            ORDER BY m.SentAt DESC, m.Id DESC
          """;

    return await conn.QueryAsync<MessageDto>(
        new CommandDefinition(sql,
            new { ConversationId = conversationId, PageSize = pageSize,
                  CursorSentAt = cursorSentAt, CursorId = cursorId },
            cancellationToken: ct));
}

public sealed record PagedResult<T>(List<T> Items, MessageCursor? NextCursor);

// ❌ Wrong: offset pagination — degrades with table size
public async Task<List<MessageDto>> GetMessagesOffsetAsync(
    Guid conversationId, int page, int pageSize, CancellationToken ct)
{
    return await _context.Messages
        .AsNoTracking()
        .Where(m => m.ConversationId == conversationId)
        .OrderByDescending(m => m.SentAt)
        .Skip((page - 1) * pageSize)     // SQL Server reads and discards all preceding rows
        .Take(pageSize)
        .Select(m => new MessageDto { Id = m.Id, Content = m.Content })
        .ToListAsync(ct);
}
```

## The Trap

```csharp
// A senior developer implements keyset pagination correctly.
// Fast. Works. Ships.
// The trap: the index does not cover the keyset columns in the right order.

// The query: WHERE ConversationId = @id AND SentAt < @cursor ORDER BY SentAt DESC
// Existing index: IX_Messages_ConversationId (ConversationId ASC)
// SQL Server uses the index to find the conversation, then scans SentAt — partial help.

// The query hits a table scan on SentAt for large conversations.
// At 10,000 messages per conversation, this is acceptable.
// At 1,000,000 messages, it is a 3am page.

// Fix: composite index covering the exact keyset columns in the exact order
// CREATE INDEX IX_Messages_Conversation_Keyset
// ON Messages (ConversationId, SentAt DESC, Id DESC)
// WHERE IsDeleted = 0   -- filtered index: only active messages
// INCLUDE (Content, SenderId)  -- covering: avoid key lookup

// The INCLUDE columns are the ones in your SELECT — avoids a second lookup per row.
// Without INCLUDE, SQL Server does a key lookup for each row returned.
// With 20 rows per page, that is 20 extra lookups — invisible at small scale, fatal at large.
```

## The Exception
Offset pagination is acceptable for: admin dashboards where pages are not scrolled sequentially (a user jumps to "page 47"), reports that are generated once and cached, and datasets with fewer than 10,000 rows that grow slowly. The rule against offset applies specifically to user-facing infinite scroll, chat history, and any paginated list that grows continuously. For admin reporting, offset with a total count is cleaner to implement and the performance difference is negligible.

## Before You Merge
- Is the keyset cursor composed of the sort column plus a unique tiebreaker (e.g., `SentAt + Id`)?
- Is there a composite index on `(ConversationId, SentAt DESC, Id DESC)` covering the keyset columns?
- Does the API cap `pageSize` server-side — rejecting client-supplied values above the maximum?
- Does `Take(pageSize + 1)` detect next-page existence without a separate `COUNT` query?
- Is the cursor opaque to the client (base64 encoded) — so clients cannot manually construct arbitrary cursors?
