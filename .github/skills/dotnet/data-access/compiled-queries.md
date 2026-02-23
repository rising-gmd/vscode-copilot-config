# Compiled Queries
> Verified against: .NET 9 | C# 13 | EF Core 9.x
> Last reviewed: 2026-02-22

## The Law
Compile frequently-executed EF Core queries with `EF.CompileAsyncQuery` — every uncompiled query pays a LINQ-to-SQL translation cost on every call, including query plan generation overhead.

## Why This Kills You At Scale
EF Core translates your LINQ expression to SQL on every single call — the translation itself is fast (microseconds), but at 100k users making 10 requests/second, you are paying that translation cost 1,000,000 times per second. Compiled queries eliminate the translation overhead entirely. The real cost is query plan caching in SQL Server: uncompiled queries with parameter sniffing issues generate bad plans that persist — compiled queries with stable parameterization avoid this class of problem entirely.

## The Pattern

```csharp
#nullable enable
using Microsoft.EntityFrameworkCore;

// ✅ Correct: compiled queries as static fields — compiled once at startup
public static class CompiledQueries
{
    // ✅ Compiled async query — LINQ translated to SQL once, reused forever
    public static readonly Func<AppDbContext, Guid, CancellationToken, Task<User?>>
        GetUserById = EF.CompileAsyncQuery(
            (AppDbContext ctx, Guid userId, CancellationToken ct) =>
                ctx.Users
                    .AsNoTracking()
                    .Where(u => u.Id == userId && !u.IsDeleted)
                    .Select(u => new User { Id = u.Id, Username = u.Username, Email = u.Email })
                    .FirstOrDefault());

    // ✅ Compiled query returning IAsyncEnumerable — for streaming results
    public static readonly Func<AppDbContext, Guid, IAsyncEnumerable<MessageDto>>
        GetConversationMessages = EF.CompileAsyncQuery(
            (AppDbContext ctx, Guid conversationId) =>
                ctx.Messages
                    .AsNoTracking()
                    .Where(m => m.ConversationId == conversationId && !m.IsDeleted)
                    .OrderByDescending(m => m.SentAt)
                    .Select(m => new MessageDto
                    {
                        Id = m.Id,
                        Content = m.Content,
                        SentAt = m.SentAt
                    }));

    // ✅ Compiled existence check — hot path
    public static readonly Func<AppDbContext, Guid, Guid, CancellationToken, Task<bool>>
        IsConversationMember = EF.CompileAsyncQuery(
            (AppDbContext ctx, Guid conversationId, Guid userId, CancellationToken _) =>
                ctx.ConversationMembers
                    .Any(cm => cm.ConversationId == conversationId && cm.UserId == userId));
}

// ✅ Correct: use in repository
public sealed class UserRepository(AppDbContext context)
{
    public Task<User?> GetByIdAsync(Guid userId, CancellationToken ct)
        // Direct call — no lambda allocation, no LINQ translation
        => CompiledQueries.GetUserById(context, userId, ct);

    public IAsyncEnumerable<MessageDto> GetMessages(Guid conversationId)
        => CompiledQueries.GetConversationMessages(context, conversationId);
}

// ❌ Wrong: uncompiled query on hot path — translation cost on every call
public async Task<User?> GetByIdSlowAsync(Guid userId, CancellationToken ct)
{
    return await _context.Users
        .AsNoTracking()
        .Where(u => u.Id == userId)     // LINQ expression tree built and translated every call
        .FirstOrDefaultAsync(ct);        // In isolation: fine. At 10k/sec: measurable overhead
}

// ✅ Correct: when NOT to compile — dynamic queries cannot be compiled
public async Task<List<User>> SearchUsersAsync(
    string? username, bool? isActive, CancellationToken ct)
{
    // Dynamic WHERE clauses change structure based on parameters — cannot be pre-compiled
    // Use Dapper for these, or accept the translation cost (it is usually negligible for search)
    var query = _context.Users.AsNoTracking().AsQueryable();
    if (username is not null) query = query.Where(u => u.Username.Contains(username));
    if (isActive.HasValue) query = query.Where(u => u.IsActive == isActive.Value);
    return await query.Select(u => new User { Id = u.Id, Username = u.Username }).ToListAsync(ct);
}
```

## The Trap

```csharp
// A senior developer adds compiled queries for hot paths.
// Performance improves. Ships.
// The trap: compiled queries capture their parameters by position — not name.
// Adding a parameter in the wrong position produces silent wrong results.

// ❌ Wrong parameter order — compiles fine, silently returns wrong data
public static readonly Func<AppDbContext, Guid, Guid, CancellationToken, Task<Message?>>
    GetMessageBroken = EF.CompileAsyncQuery(
        (AppDbContext ctx, Guid senderId, Guid conversationId, CancellationToken _) =>
            ctx.Messages.Where(m =>
                m.ConversationId == senderId &&    // BUG: senderId used as conversationId
                m.SenderId == conversationId)       // BUG: conversationId used as senderId
            .FirstOrDefault());

// Usage: GetMessageBroken(ctx, conversationId, senderId, ct)
// Developer swaps the call arguments to compensate — but future refactors swap them back.
// No compiler error. No runtime error. Wrong data silently returned.

// Fix: parameter names in the lambda must match their semantic purpose.
// Add a comment above every compiled query showing the CORRECT call signature:
// Usage: GetMessage(ctx, conversationId: X, senderId: Y, ct)
public static readonly Func<AppDbContext, Guid, Guid, CancellationToken, Task<Message?>>
    GetMessage = EF.CompileAsyncQuery(
        // Parameters: conversationId, senderId
        (AppDbContext ctx, Guid conversationId, Guid senderId, CancellationToken _) =>
            ctx.Messages.Where(m =>
                m.ConversationId == conversationId &&
                m.SenderId == senderId)
            .FirstOrDefault());
```

## The Exception
Queries that are inherently dynamic — search with optional filters, admin queries with variable sort columns, reporting queries built from user selections — cannot be compiled because their structure changes per call. Use Dapper for these. The compile/Dapper boundary should be: fixed-structure hot-path queries → compiled EF Core; variable-structure or complex join queries → Dapper.

## Before You Merge
- Are compiled queries declared as `static readonly` fields — not created inside methods per call?
- Do parameter names in the compiled query lambda match their semantic purpose with a usage comment?
- Are compiled queries used only for fixed-structure queries — not for queries with dynamic WHERE clauses?
- Is the compiled query placed in a dedicated static class (`CompiledQueries`) — not scattered across repositories?
- Are high-frequency endpoints (auth, message load, conversation list) using compiled queries for their core lookups?
