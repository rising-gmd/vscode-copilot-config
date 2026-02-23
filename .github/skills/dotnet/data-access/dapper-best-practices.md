# Dapper Best Practices
> Verified against: .NET 9 | C# 13 | Dapper 2.x
> Last reviewed: 2026-02-22

## The Law
Use Dapper for complex read queries, reporting, and stored procedures — never for writes that participate in a Unit of Work transaction managed by EF Core.

## Why This Kills You At Scale
A developer uses Dapper to insert a message inside a method that also calls EF Core's `SaveChangesAsync()` — the Dapper insert uses a separate connection and commits immediately, outside the EF transaction. If `SaveChangesAsync()` subsequently fails and rolls back, the Dapper insert is permanent. At 100k messages/day, this produces orphaned data that silently corrupts your system state — messages with no conversation, participants with no user.

## The Pattern

```csharp
#nullable enable
using Dapper;
using System.Data;

// ✅ Correct: Dapper for complex reads — EF Core cannot express this efficiently
public sealed class DapperConversationRepository(IDbConnectionFactory factory)
{
    public async Task<IReadOnlyList<ConversationSummaryDto>> GetForUserAsync(
        Guid userId,
        int pageSize,
        Guid? cursorLastActivity, // Keyset pagination — not offset
        CancellationToken ct)
    {
        using var conn = factory.CreateConnection();

        const string sql = """
            SELECT
                c.Id                AS ConversationId,
                u.Username          AS OtherUsername,
                u.ProfilePictureUrl AS OtherProfilePictureUrl,
                m.Content           AS LastMessageText,
                m.SentAt            AS LastMessageSentAt,
                c.LastActivity,
                COUNT(unread.Id)    AS UnreadCount
            FROM Conversations c
            INNER JOIN ConversationParticipants cp ON cp.ConversationId = c.Id
                AND cp.UserId = @UserId
            INNER JOIN ConversationParticipants other ON other.ConversationId = c.Id
                AND other.UserId != @UserId
            INNER JOIN Users u ON u.Id = other.UserId
            LEFT JOIN Messages m ON m.Id = (
                SELECT TOP 1 Id FROM Messages
                WHERE ConversationId = c.Id AND IsDeleted = 0
                ORDER BY SentAt DESC
            )
            LEFT JOIN Messages unread ON unread.ConversationId = c.Id
                AND unread.SenderId != @UserId
                AND unread.ReadAt IS NULL
                AND unread.IsDeleted = 0
            WHERE c.IsDeleted = 0
              AND (@Cursor IS NULL OR c.LastActivity < @Cursor)
            GROUP BY c.Id, u.Username, u.ProfilePictureUrl, m.Content, m.SentAt, c.LastActivity
            ORDER BY c.LastActivity DESC
            OFFSET 0 ROWS FETCH NEXT @PageSize ROWS ONLY
            """;

        var results = await conn.QueryAsync<ConversationSummaryDto>(
            new CommandDefinition(
                sql,
                new { UserId = userId, Cursor = cursorLastActivity, PageSize = pageSize },
                cancellationToken: ct));

        return results.ToList();
    }

    // ✅ Correct: QueryMultiple — multiple result sets in one round trip
    public async Task<(ConversationDto Conversation, IReadOnlyList<MessageDto> Messages)>
        GetConversationWithMessagesAsync(Guid conversationId, Guid userId, CancellationToken ct)
    {
        using var conn = factory.CreateConnection();

        const string sql = """
            SELECT * FROM Conversations WHERE Id = @ConversationId AND IsDeleted = 0;
            SELECT TOP 50 * FROM Messages
            WHERE ConversationId = @ConversationId AND IsDeleted = 0
            ORDER BY SentAt DESC;
            """;

        using var multi = await conn.QueryMultipleAsync(
            new CommandDefinition(sql, new { ConversationId = conversationId }, cancellationToken: ct));

        var conversation = await multi.ReadFirstOrDefaultAsync<ConversationDto>()
            ?? throw new NotFoundException("Conversation not found");
        var messages = (await multi.ReadAsync<MessageDto>()).ToList();

        return (conversation, messages);
    }

    // ✅ Correct: Dapper within an existing EF transaction — safe
    public async Task AtomicOperationAsync(
        Guid conversationId,
        IDbTransaction existingTransaction, // Passed from EF Core's transaction
        CancellationToken ct)
    {
        var conn = existingTransaction.Connection
            ?? throw new InvalidOperationException("Transaction has no connection");

        await conn.ExecuteAsync(
            new CommandDefinition(
                "UPDATE Conversations SET LastActivity = @Now WHERE Id = @Id",
                new { Now = DateTime.UtcNow, Id = conversationId },
                existingTransaction,
                cancellationToken: ct));
    }

    // ❌ Wrong: Dapper write without transaction coordination
    public async Task InsertMessageInsecureAsync(Message message, CancellationToken ct)
    {
        using var conn = factory.CreateConnection();
        // Opens its own connection, auto-commits — not part of any EF transaction
        await conn.ExecuteAsync(
            "INSERT INTO Messages (Id, Content, ConversationId) VALUES (@Id, @Content, @ConvId)",
            new { message.Id, message.Content, ConvId = message.ConversationId });
        // If EF Core rolls back after this, the message stays — orphaned data
    }
}
```

## The Trap

```csharp
// A senior developer correctly separates Dapper reads from EF writes.
// Dapper is fast. All reads use it. Ships.
// The trap: column name mapping fails silently for nullable types.

public sealed class MessageDto
{
    public Guid Id { get; init; }
    public string Content { get; init; } = string.Empty;
    public DateTime SentAt { get; init; }
    public DateTime? ReadAt { get; init; }      // Nullable DateTime
    public string? SenderProfilePic { get; init; } // Nullable string
}

// Dapper maps by column name — case-insensitive, but exact match required.
// SQL returns column "read_at" (snake_case), DTO has "ReadAt" (PascalCase).
// Dapper silently maps to null — ReadAt is always null regardless of DB value.
// Tests pass because test data always has null ReadAt.
// Production: "mark as read" appears broken — UI always shows unread badge.

// Fix 1: alias columns in SQL to match DTO property names exactly
const string sql = """
    SELECT
        read_at AS ReadAt,           -- Explicit alias
        sender_profile_pic AS SenderProfilePic
    FROM Messages
    """;

// Fix 2: configure DefaultTypeMap to handle snake_case globally
Dapper.DefaultTypeMap.MatchNamesWithUnderscores = true; // Enables snake_case mapping

// Fix 3: custom type map per type
SqlMapper.SetTypeMap(typeof(MessageDto),
    new CustomPropertyTypeMap(typeof(MessageDto), (type, columnName) =>
        type.GetProperties().FirstOrDefault(p =>
            string.Equals(p.Name, columnName.Replace("_", ""), StringComparison.OrdinalIgnoreCase))!));
```

## The Exception
Dapper writes are correct when the operation is entirely self-contained with no EF Core context involved — a standalone audit log writer, a Hangfire job that only does DB writes via Dapper with its own transaction, or an admin one-off script. The restriction is specifically about mixing Dapper writes with EF Core's Unit of Work in the same logical operation. If you have no EF context, Dapper writes with explicit transactions are completely correct.

## Before You Merge
- Are all Dapper operations using named parameters (`@Param`) — never string interpolation?
- Are Dapper writes that participate in a Unit of Work using the same `IDbTransaction` as EF Core?
- Are column names in SQL aliases matching DTO property names exactly — or is `MatchNamesWithUnderscores` configured?
- Does `QueryMultiple` dispose the `GridReader` via `using` — not leave it open?
- Are Dapper connections disposed via `using` — not held open across awaits in the same method?
