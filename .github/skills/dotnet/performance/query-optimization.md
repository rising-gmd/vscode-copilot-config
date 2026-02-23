# Query Optimization
> Verified against: .NET 9 | C# 13 | EF Core 9.x | SQL Server 2022
> Last reviewed: 2026-02-22

## The Law
Measure generated SQL before shipping any query that touches a table over 100,000 rows — enable query logging in development, inspect execution plans for every new endpoint, and treat a table scan on a large table as a build-blocking defect.

## Why This Kills You At Scale
At one billion users and 50 billion messages, a single missing index transforms a 2ms query into a 45-second full table scan that holds shared locks, blocks writes, cascades into lock timeouts across the system, and brings the entire database to its knees. This is not a gradual degradation — it is an instantaneous cliff. The query runs fine in staging with 10,000 rows. It kills production at 100,000,000 rows. The only way to know before it kills you is to look at the execution plan.

## The Pattern

```csharp
#nullable enable
using Microsoft.EntityFrameworkCore;

// ✅ Correct: enable query logging in development — see every SQL statement
// In Program.cs:
if (builder.Environment.IsDevelopment())
{
    builder.Services.AddDbContext<AppDbContext>(options =>
        options.UseSqlServer(connectionString)
               .LogTo(Console.WriteLine, LogLevel.Information)
               .EnableSensitiveDataLogging()   // Shows parameter values
               .EnableDetailedErrors());        // Better exception messages
}

// ✅ Correct: compiled queries for hot path queries — eliminates LINQ translation overhead
// At 1B users, LINQ → SQL translation overhead adds up
public sealed class MessageQueryService
{
    // Compiled once at startup — zero translation cost on every call
    private static readonly Func<AppDbContext, Guid, int, IAsyncEnumerable<MessageProjection>>
        GetPagedMessages = EF.CompileAsyncQuery(
            (AppDbContext db, Guid conversationId, int take) =>
                db.Messages
                  .AsNoTracking()
                  .Where(m => m.ConversationId == conversationId && !m.IsDeleted)
                  .OrderByDescending(m => m.SentAt)
                  .Take(take)
                  .Select(m => new MessageProjection(
                      m.Id,
                      m.Content,
                      m.SenderId,
                      m.SentAt,
                      m.Sender!.Username)));

    public async Task<IReadOnlyList<MessageProjection>> GetLatestAsync(
        AppDbContext db,
        Guid conversationId,
        int pageSize,
        CancellationToken ct)
    {
        var results = new List<MessageProjection>();
        await foreach (var msg in GetPagedMessages(db, conversationId, pageSize)
            .WithCancellation(ct))
        {
            results.Add(msg);
        }
        return results;
    }
}

public sealed record MessageProjection(
    Guid Id,
    string Content,
    Guid SenderId,
    DateTime SentAt,
    string SenderUsername);

// ✅ Correct: keyset pagination — not offset — for large datasets
// Offset pagination at page 50,000 requires DB to read and discard 50,000 * pageSize rows
public sealed class ConversationRepository(AppDbContext context)
{
    public async Task<IReadOnlyList<ConversationSummaryDto>> GetPagedAsync(
        Guid userId,
        DateTime? cursorLastActivity, // Last item from previous page
        int pageSize,
        CancellationToken ct)
    {
        var query = context.ConversationParticipants
            .AsNoTracking()
            .Where(p => p.UserId == userId);

        // ✅ Keyset: WHERE LastActivity < @cursor — uses index seek, not scan
        if (cursorLastActivity.HasValue)
            query = query.Where(p =>
                p.Conversation.LastActivity < cursorLastActivity.Value);

        return await query
            .OrderByDescending(p => p.Conversation.LastActivity)
            .Take(pageSize)
            .Select(p => new ConversationSummaryDto
            {
                ConversationId = p.ConversationId,
                LastActivity   = p.Conversation.LastActivity,
                LastMessage    = p.Conversation.Messages
                    .OrderByDescending(m => m.SentAt)
                    .Select(m => m.Content)
                    .FirstOrDefault()
            })
            .ToListAsync(ct);
    }
}

// ✅ Correct: projection over entity loading — select only what the query needs
public async Task<IReadOnlyList<UserSearchResultDto>> SearchUsersAsync(
    string term,
    Guid excludeUserId,
    CancellationToken ct)
{
    return await context.Users
        .AsNoTracking()
        .Where(u => u.IsActive
                 && !u.IsDeleted
                 && u.Id != excludeUserId
                 // ✅ LIKE with leading wildcard prevented by requiring minimum 3 chars
                 // Minimum length enforced in validator before this call
                 && (u.Username.StartsWith(term) || u.DisplayName.StartsWith(term)))
        .Take(20) // Hard cap — prevent accidental full-table projections
        .Select(u => new UserSearchResultDto(
            u.Id,
            u.Username,
            u.DisplayName,
            u.ProfilePictureUrl))
        .ToListAsync(ct);
}

// ✅ Correct: raw Dapper for complex analytics queries
// EF Core cannot express window functions, CTEs, or complex JOINs efficiently
public async Task<ConversationStatsDto> GetConversationStatsAsync(
    Guid conversationId,
    CancellationToken ct)
{
    const string sql = """
        WITH MessageStats AS (
            SELECT
                COUNT(*)                                    AS TotalMessages,
                COUNT(DISTINCT SenderId)                    AS UniqueParticipants,
                MIN(SentAt)                                 AS FirstMessageAt,
                MAX(SentAt)                                 AS LastMessageAt,
                SUM(CASE WHEN ReadAt IS NULL THEN 1 ELSE 0 END) AS UnreadCount
            FROM Messages WITH (NOLOCK) -- Dirty read acceptable for stats
            WHERE ConversationId = @ConversationId
              AND IsDeleted = 0
        )
        SELECT * FROM MessageStats
        """;

    using var conn = _connectionFactory.CreateConnection();
    return await conn.QueryFirstOrDefaultAsync<ConversationStatsDto>(
        new CommandDefinition(sql,
            new { ConversationId = conversationId },
            cancellationToken: ct))
        ?? new ConversationStatsDto();
}

// ❌ Wrong: N+1 query — one query per iteration
public async Task<IReadOnlyList<ConversationSummaryDto>> GetConversationsN1Async(
    Guid userId,
    CancellationToken ct)
{
    var participants = await context.ConversationParticipants
        .Where(p => p.UserId == userId)
        .ToListAsync(ct);

    var results = new List<ConversationSummaryDto>();
    foreach (var p in participants)
    {
        // BUG: one query per conversation — 100 conversations = 101 DB roundtrips
        var lastMessage = await context.Messages
            .Where(m => m.ConversationId == p.ConversationId)
            .OrderByDescending(m => m.SentAt)
            .FirstOrDefaultAsync(ct);

        results.Add(new ConversationSummaryDto
        {
            ConversationId = p.ConversationId,
            LastMessage    = lastMessage?.Content
        });
    }
    return results;
}
```

## The Trap

```csharp
// A senior developer correctly uses compiled queries, keyset pagination, projections.
// Execution plans look clean. Ships to staging with 500k rows. All green.
// The trap: WITH (NOLOCK) used everywhere as a "performance hint"
// creates invisible, undetected data corruption reads.

// WITH (NOLOCK) = READ UNCOMMITTED isolation level.
// It means you can read rows that are in the middle of being inserted or updated.
// At billion-user scale, an in-flight transaction inserting a message
// consists of multiple page writes. NOLOCK can read a partially written state —
// you see a message with NULL content, or a message with the old content
// that is being updated to new content.
// This is not a theoretical risk. At 1B users / 50B messages, it happens constantly.

// NOLOCK is acceptable ONLY for:
// 1. Approximate aggregate stats where exact accuracy is not required
// 2. Background analytics that tolerate dirty reads
// NOLOCK is NEVER acceptable for:
// 1. Messages — users see corrupted or missing content
// 2. Authentication data — security decisions on stale data
// 3. Financial data — obvious
// 4. Any data that drives user-visible state

// Fix: use READ COMMITTED SNAPSHOT ISOLATION (RCSI) at the database level
// This gives non-blocking reads WITHOUT dirty reads — the best of both worlds
// Enable once at DB level:
// ALTER DATABASE YourDb SET READ_COMMITTED_SNAPSHOT ON;
// Then remove ALL WITH (NOLOCK) hints — RCSI makes them unnecessary and dangerous

// With RCSI enabled:
// - Readers never block writers
// - Writers never block readers
// - No dirty reads
// - No phantom reads for most workloads
// This is the correct solution for a high-concurrency chat application.
// Enable it on day one. Never add NOLOCK hints.
```

## The Exception
Statistics dashboards, admin analytics, and monitoring queries that explicitly tolerate dirty reads — "approximately how many messages were sent in the last hour" — can use `WITH (NOLOCK)` or `READ UNCOMMITTED` explicitly, with a comment documenting why the dirty read is acceptable for this specific query. The comment is mandatory. Any `NOLOCK` without a justification comment is a bug waiting to surface.

## Before You Merge
- Has the generated SQL for every new query hitting tables over 100k rows been verified via query logging?
- Are all hot-path queries using EF Core compiled queries — not re-translated on every call?
- Is pagination using keyset cursors — not `Skip(n).Take(m)` offset which degrades linearly with page depth?
- Is `WITH (NOLOCK)` absent from all queries that affect user-visible data — messages, conversations, auth state?
- Is `READ_COMMITTED_SNAPSHOT` enabled on the database — eliminating the need for NOLOCK entirely?
