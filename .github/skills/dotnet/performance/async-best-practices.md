# Async Best Practices
> Verified against: .NET 9 | C# 13 | ASP.NET Core 9.x
> Last reviewed: 2026-02-22

## The Law
Async all the way down — never block an async call with `.Result`, `.Wait()`, or `GetAwaiter().GetResult()` anywhere in the call stack, and never use `async void` outside of event handlers.

## Why This Kills You At Scale
At one billion users, thread starvation from `.Result` deadlocks is the difference between serving 50,000 concurrent requests and having your server hang completely. ASP.NET Core's thread pool has a fixed number of threads. A single `.Result` call blocks a thread pool thread waiting for an async operation that needs another thread pool thread to complete — which is also blocked. Thread pool fills. New requests queue. Queue grows. Within seconds, every request times out. The server appears to be up (health checks pass) but serves nothing. This is the most common catastrophic async failure pattern and it always happens under production load, never in development.

## The Pattern

```csharp
#nullable enable
using System.Runtime.CompilerServices;

// ✅ Correct: async all the way — every level awaits properly
public sealed class MessageService(IMessageRepository repo)
{
    public async Task<MessageDto> GetByIdAsync(Guid id, CancellationToken ct)
    {
        var message = await repo.GetByIdAsync(id, ct)
            ?? throw new NotFoundException($"Message {id} not found");

        return message.ToDto();
    }
}

public sealed class MessageRepository(AppDbContext context)
{
    public async Task<Message?> GetByIdAsync(Guid id, CancellationToken ct)
        => await context.Messages.FindAsync([id], ct);
}

// ✅ Correct: ConfigureAwait(false) in library/infrastructure code
// Not needed in ASP.NET Core (no SynchronizationContext) but correct in libraries
public sealed class HashingService
{
    public async Task<HashResult> HashAsync(string input, CancellationToken ct)
    {
        // ConfigureAwait(false) in infrastructure/library code
        // Prevents capturing SynchronizationContext — reduces overhead in library scenarios
        var salt = await GenerateSaltAsync(ct).ConfigureAwait(false);
        var hash = await ComputeHashAsync(input, salt, ct).ConfigureAwait(false);
        return new HashResult(hash, salt);
    }

    private static Task<byte[]> GenerateSaltAsync(CancellationToken ct)
        => Task.Run(() => RandomNumberGenerator.GetBytes(32), ct);

    private static Task<string> ComputeHashAsync(string input, byte[] salt, CancellationToken ct)
        => Task.Run(() =>
        {
            using var hmac = new HMACSHA256(salt);
            return Convert.ToBase64String(
                hmac.ComputeHash(Encoding.UTF8.GetBytes(input)));
        }, ct);
}

// ✅ Correct: parallel async — fan-out without sequential awaiting
public sealed class ConversationDashboardService(
    IConversationRepository convRepo,
    IUserRepository userRepo,
    IMessageRepository messageRepo)
{
    public async Task<DashboardDto> GetDashboardAsync(Guid userId, CancellationToken ct)
    {
        // ✅ Start all three tasks simultaneously — not sequentially
        var conversationsTask = convRepo.GetForUserAsync(userId, ct);
        var profileTask       = userRepo.GetProfileAsync(userId, ct);
        var unreadCountTask   = messageRepo.GetTotalUnreadAsync(userId, ct);

        // ✅ WhenAll — all three run in parallel, total time = max(t1, t2, t3)
        // NOT sum(t1, t2, t3) as sequential awaits would produce
        await Task.WhenAll(conversationsTask, profileTask, unreadCountTask);

        return new DashboardDto(
            Conversations: await conversationsTask,
            Profile:       await profileTask,
            UnreadCount:   await unreadCountTask);
    }
}

// ✅ Correct: IAsyncEnumerable for streaming large result sets
// Never load 1 million rows into memory — stream them
public async IAsyncEnumerable<MessageDto> StreamConversationHistoryAsync(
    Guid conversationId,
    [EnumeratorCancellation] CancellationToken ct)
{
    await foreach (var message in context.Messages
        .AsNoTracking()
        .Where(m => m.ConversationId == conversationId)
        .OrderBy(m => m.SentAt)
        .AsAsyncEnumerable()
        .WithCancellation(ct))
    {
        yield return message.ToDto();
    }
}

// ✅ Correct: ValueTask for hot paths that frequently return synchronously
// A method that returns a cached result 95% of the time wastes a Task allocation otherwise
public sealed class PresenceService
{
    private readonly Dictionary<Guid, bool> _localCache = new();

    public ValueTask<bool> IsOnlineAsync(Guid userId, CancellationToken ct)
    {
        // Hot path: in-memory cache hit — no allocation, synchronous return
        if (_localCache.TryGetValue(userId, out var isOnline))
            return ValueTask.FromResult(isOnline);

        // Cold path: go to Redis — allocates Task
        return new ValueTask<bool>(FetchFromRedisAsync(userId, ct));
    }

    private async Task<bool> FetchFromRedisAsync(Guid userId, CancellationToken ct)
    {
        // ... Redis call
        return false;
    }
}

// ❌ Wrong: blocking async — deadlock under load
public sealed class BlockingService
{
    public MessageDto GetMessage(Guid id)
    {
        // Blocks thread pool thread waiting for async operation
        // Under load: fills thread pool → deadlock → server hangs
        return GetMessageAsync(id, CancellationToken.None).Result; // NEVER
    }

    public MessageDto GetMessageAlsoWrong(Guid id)
    {
        return GetMessageAsync(id, CancellationToken.None)
            .GetAwaiter()
            .GetResult(); // NEVER — same deadlock, just disguised
    }

    private Task<MessageDto> GetMessageAsync(Guid id, CancellationToken ct)
        => Task.FromResult(new MessageDto(id, "", Guid.Empty, DateTime.UtcNow));
}

// ❌ Wrong: async void — exceptions are unobserved, crash the process
public sealed class BadEventHandler
{
    public async void OnMessageReceived(object sender, EventArgs e)
    {
        // Exception here kills the process silently — no stack trace, no log
        await ProcessMessageAsync();
    }

    // ✅ Correct: event handler wraps async properly
    public void OnMessageReceivedCorrect(object sender, EventArgs e)
    {
        _ = ProcessWithLoggingAsync();
    }

    private async Task ProcessWithLoggingAsync()
    {
        try { await ProcessMessageAsync(); }
        catch (Exception ex) { _logger.LogError(ex, "Event handler failed"); }
    }

    private Task ProcessMessageAsync() => Task.CompletedTask;
}
```

## The Trap

```csharp
// A senior developer correctly makes all paths async, uses WhenAll for parallelism.
// Passes load testing at 10,000 concurrent users. Ships.
// The trap: Task.WhenAll swallows all but the first exception.

public async Task<DashboardDto> GetDashboardAsync(Guid userId, CancellationToken ct)
{
    var conversationsTask = convRepo.GetForUserAsync(userId, ct);
    var profileTask       = userRepo.GetProfileAsync(userId, ct);
    var unreadCountTask   = messageRepo.GetTotalUnreadAsync(userId, ct);

    // BUG: if profileTask and unreadCountTask both throw,
    // WhenAll wraps them in an AggregateException containing BOTH errors.
    // But when you await WhenAll, only the FIRST exception is re-thrown.
    // The second exception is silently lost.
    // At billion-user scale: you have 2 errors per failed request,
    // but your error tracking only shows half your failures.
    await Task.WhenAll(conversationsTask, profileTask, unreadCountTask);

    // Fix: explicitly inspect all results after WhenAll
    var exceptions = new List<Exception>();

    if (conversationsTask.IsFaulted) exceptions.Add(conversationsTask.Exception!);
    if (profileTask.IsFaulted)       exceptions.Add(profileTask.Exception!);
    if (unreadCountTask.IsFaulted)   exceptions.Add(unreadCountTask.Exception!);

    if (exceptions.Count > 0)
        throw new AggregateException("Dashboard load failed", exceptions);

    return new DashboardDto(
        Conversations: conversationsTask.Result,
        Profile:       profileTask.Result,
        UnreadCount:   unreadCountTask.Result);
}

// Alternative: use WhenEach (.NET 9) for progressive results
// Or: use structured error handling per task before aggregating
```

## The Exception
CPU-bound synchronous work (image processing, cryptographic operations, complex calculations) should be wrapped in `Task.Run()` to run on a thread pool thread and keep the calling thread free — but the caller still awaits the result asynchronously. The rule against blocking applies to I/O-bound operations. CPU-bound operations legitimately occupy a thread for their duration — `Task.Run` is the correct way to keep that off the ASP.NET Core request thread.

## Before You Merge
- Is `.Result`, `.Wait()`, and `.GetAwaiter().GetResult()` completely absent from the entire codebase — verified by a Roslyn analyzer or grep in CI?
- Is `async void` absent except in UI event handlers — verified by a code analysis rule?
- Are independent async operations dispatched simultaneously with `Task.WhenAll` — not awaited sequentially?
- Does `Task.WhenAll` usage inspect all faulted tasks individually — not relying on the first-exception re-throw?
- Are hot paths that return synchronously 90%+ of the time using `ValueTask<T>` — not `Task<T>`?
