# Transaction Management
> Verified against: .NET 9 | C# 13 | EF Core 9.x | Dapper 2.x
> Last reviewed: 2026-02-22

## The Law
Transactions must span exactly the operations that must succeed or fail together — never open a transaction before acquiring external resources (locks, network calls, file I/O) and never leave a transaction open across multiple HTTP requests.

## Why This Kills You At Scale
A transaction opened before calling an external email service holds DB locks for the duration of the email API call — typically 200-2000ms. At 100k users with 10 concurrent registrations/second, you have 10 transactions holding locks for 2 seconds each, creating a lock queue that cascades into deadlocks, timeouts, and 503s for unrelated operations that touch the same tables. This is the single most common cause of "our DB was fine until traffic hit X" incidents.

## The Pattern

```csharp
#nullable enable
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;
using System.Data;

// ✅ Correct: Unit of Work wraps SaveChangesAsync — implicit transaction per request
// For most operations, SaveChangesAsync is its own transaction — don't add explicit ones
public sealed class UnitOfWork(AppDbContext context) : IUnitOfWork
{
    public Task<int> SaveChangesAsync(CancellationToken ct = default)
        => context.SaveChangesAsync(ct);
        // EF Core wraps all pending changes in a single DB transaction automatically
}

// ✅ Correct: explicit transaction only when spanning multiple SaveChangesAsync calls
// OR when mixing EF Core and Dapper operations that must be atomic
public async Task CreateConversationWithFirstMessageAsync(
    CreateConversationRequest request,
    CancellationToken ct)
{
    await using var transaction = await _context.Database.BeginTransactionAsync(
        IsolationLevel.ReadCommitted, ct); // Use lowest isolation that satisfies your requirements

    try
    {
        // Operation 1: create conversation
        var conversation = new Conversation { Title = request.Title, UserId = request.UserId };
        _context.Conversations.Add(conversation);
        await _context.SaveChangesAsync(ct); // First save in transaction

        // Operation 2: create first message — needs conversation.Id from above
        var message = new Message
        {
            ConversationId = conversation.Id,
            Content = request.FirstMessage,
            SenderId = request.UserId
        };
        _context.Messages.Add(message);
        await _context.SaveChangesAsync(ct); // Second save in transaction

        await transaction.CommitAsync(ct);
    }
    catch
    {
        await transaction.RollbackAsync(ct);
        throw;
    }
    // Note: no external calls (email, SignalR) inside the transaction block
    // Those happen AFTER commit, outside the transaction scope
}

// ✅ Correct: Dapper within EF Core transaction — share the connection
public async Task VerifyEmailAtomicAsync(string token, CancellationToken ct)
{
    await using var transaction = await _context.Database.BeginTransactionAsync(ct);

    try
    {
        // EF Core operation
        var user = await _context.Users
            .FirstOrDefaultAsync(u => u.EmailVerificationToken == token, ct);

        if (user is null) throw new AppException("TOKEN_INVALID", "Invalid token");

        // Dapper operation on the SAME connection and transaction
        using var dapperConn = _context.Database.GetDbConnection();
        var rows = await dapperConn.ExecuteAsync(
            new CommandDefinition(
                "UPDATE Users SET IsEmailVerified = 1, EmailVerificationToken = NULL WHERE Id = @Id",
                new { user.Id },
                transaction: transaction.GetDbTransaction(), // Share the transaction
                cancellationToken: ct));

        await transaction.CommitAsync(ct);
    }
    catch
    {
        await transaction.RollbackAsync(ct);
        throw;
    }
}

// ❌ Wrong: external call inside transaction — holds locks during network I/O
public async Task RegisterUserInsecureAsync(RegisterRequest request, CancellationToken ct)
{
    await using var tx = await _context.Database.BeginTransactionAsync(ct);
    var user = new User { Email = request.Email };
    _context.Users.Add(user);
    await _context.SaveChangesAsync(ct);

    // BUG: email API call holds DB transaction open for 200-2000ms
    await _emailService.SendVerificationEmailAsync(user.Email, ct); // External network call

    await tx.CommitAsync(ct); // Locks held for entire email call duration
}

// ✅ Fix: dispatch email AFTER transaction commit
public async Task RegisterUserSafeAsync(RegisterRequest request, CancellationToken ct)
{
    User user;
    await using (var tx = await _context.Database.BeginTransactionAsync(ct))
    {
        user = new User { Email = request.Email };
        _context.Users.Add(user);
        await _context.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);
    }
    // Transaction closed — now safe to call external services
    _backgroundJobDispatcher.EnqueueVerificationEmail(user.Email, user.Username, user.EmailVerificationToken!);
}
```

## The Trap

```csharp
// A senior developer correctly avoids external calls inside transactions.
// Uses background jobs for email. Ships.
// The trap: SaveChangesAsync with a retry strategy and an explicit transaction conflict.

// EF Core's retry-on-failure strategy (EnableRetryOnFailure) does NOT work with
// explicit transactions — it throws InvalidOperationException at runtime:
// "The configured execution strategy does not support user-initiated transactions"

// This works fine in development (no transient failures) but fails in production
// under transient SQL Azure connection drops.

// ❌ Wrong: retry strategy + explicit transaction
services.AddDbContext<AppDbContext>(options =>
    options.UseSqlServer(connectionString,
        sql => sql.EnableRetryOnFailure(3))); // This conflicts with explicit transactions

await using var tx = await _context.Database.BeginTransactionAsync(ct); // Throws in production

// Fix: use execution strategy explicitly when you need both retries and explicit transactions
public async Task CreateWithRetryAsync(CancellationToken ct)
{
    var strategy = _context.Database.CreateExecutionStrategy();

    await strategy.ExecuteAsync(async () =>
    {
        await using var tx = await _context.Database.BeginTransactionAsync(ct);
        try
        {
            // Your transactional operations here
            await _context.SaveChangesAsync(ct);
            await tx.CommitAsync(ct);
        }
        catch
        {
            await tx.RollbackAsync(ct);
            throw;
        }
    });
}
```

## The Exception
Read-only operations do not need explicit transactions. `ReadUncommitted` isolation for non-critical reads (dashboards, analytics) can improve throughput by avoiding shared locks entirely — use `SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED` in Dapper for these. Saga patterns for distributed transactions across services use eventual consistency instead of distributed ACID transactions — explicit DB transactions stop at the service boundary.

## Before You Merge
- Are external service calls (email, SignalR notifications, HTTP requests) executed AFTER `CommitAsync` — not inside the `try` block before it?
- Is `CreateExecutionStrategy()` wrapping any code that combines retry-on-failure with explicit transactions?
- Is `IsolationLevel.ReadCommitted` explicitly specified — not relying on SQL Server's default which varies by configuration?
- Is `await using` (not `using`) used for `IDbContextTransaction` to ensure async disposal?
- Do all explicit transaction blocks have a `catch { RollbackAsync(); throw; }` — no paths that exit without commit or rollback?
