# Decorator Pattern
> Verified against: .NET 9 | C# 13 | Microsoft.Extensions.DependencyInjection 9.x
> Last reviewed: 2026-02-22

## The Law
Add cross-cutting behaviour to services by wrapping them in decorators registered in DI — never modify the original service class to add logging, caching, or retry logic.

## Why This Kills You At Scale
A `MessageService` with logging, caching, retry, and auditing baked directly into its methods becomes a 600-line class where the actual business logic is buried under infrastructure concerns. At 100k users requiring per-feature toggles (disable caching for admins, skip retry for internal calls), you cannot selectively compose behaviours — it is all or nothing, baked into the class. The Decorator pattern keeps each concern in its own testable class that can be composed differently per context.

## The Pattern

```csharp
#nullable enable
using Microsoft.Extensions.Caching.Memory;

// ✅ Correct: core service — pure business logic, zero infrastructure
public sealed class MessageService(
    IMessageRepository repo,
    IUnitOfWork unitOfWork,
    IRealTimeNotifier notifier,
    ICurrentUserService currentUser) : IMessageService
{
    public async Task<MessageDto> GetByIdAsync(Guid id, CancellationToken ct)
    {
        var userId = currentUser.GetUserId();
        var message = await repo.GetByIdAsync(id, ct)
            ?? throw new NotFoundException($"Message {id} not found");

        if (message.SenderId != userId)
            throw new ForbiddenException("Access denied");

        return message.ToDto();
    }

    public async Task<MessageDto> SendAsync(
        SendMessageRequest request, CancellationToken ct)
    {
        var userId = currentUser.GetUserId();
        var message = Message.Create(request.ConversationId, userId, request.Content);
        await repo.AddAsync(message, ct);
        await unitOfWork.SaveChangesAsync(ct);
        await notifier.NotifyMessageSentAsync(request.ConversationId, message.ToDto(), ct);
        return message.ToDto();
    }
}

// ✅ Correct: caching decorator — wraps IMessageService transparently
public sealed class CachingMessageService(
    IMessageService inner,         // Wraps the real service
    IMemoryCache cache,
    ILogger<CachingMessageService> logger) : IMessageService
{
    private static string CacheKey(Guid id) => $"message:{id}";

    public async Task<MessageDto> GetByIdAsync(Guid id, CancellationToken ct)
    {
        // Check cache first
        if (cache.TryGetValue(CacheKey(id), out MessageDto? cached) && cached is not null)
        {
            logger.LogDebug("Cache hit for message {MessageId}", id);
            return cached;
        }

        // Call inner service — gets from DB
        var result = await inner.GetByIdAsync(id, ct);

        // Cache the result
        cache.Set(CacheKey(id), result, TimeSpan.FromMinutes(5));
        return result;
    }

    // ✅ Pass-through for writes — caching only makes sense for reads
    public Task<MessageDto> SendAsync(SendMessageRequest request, CancellationToken ct)
        => inner.SendAsync(request, ct);
}

// ✅ Correct: logging decorator — wraps for audit and performance tracking
public sealed class LoggingMessageService(
    IMessageService inner,
    ILogger<LoggingMessageService> logger,
    ICurrentUserService currentUser) : IMessageService
{
    public async Task<MessageDto> GetByIdAsync(Guid id, CancellationToken ct)
    {
        var sw = System.Diagnostics.Stopwatch.StartNew();
        var result = await inner.GetByIdAsync(id, ct);
        sw.Stop();

        logger.LogInformation(
            "GetMessage {MessageId} by {UserId} in {ElapsedMs}ms",
            id, currentUser.GetUserId(), sw.ElapsedMilliseconds);

        return result;
    }

    public async Task<MessageDto> SendAsync(SendMessageRequest request, CancellationToken ct)
    {
        var result = await inner.SendAsync(request, ct);
        logger.LogInformation(
            "MessageSent {MessageId} to conversation {ConversationId} by {UserId}",
            result.Id, request.ConversationId, currentUser.GetUserId());
        return result;
    }
}

// ✅ Correct: DI composition — order of decorators = order of execution
// Outer → LoggingMessageService → CachingMessageService → MessageService → Repo
builder.Services.AddScoped<MessageService>();  // Core implementation
builder.Services.AddScoped<IMessageService>(sp =>
{
    var core = sp.GetRequiredService<MessageService>();
    var cache = sp.GetRequiredService<IMemoryCache>();
    var logger1 = sp.GetRequiredService<ILogger<CachingMessageService>>();
    var logger2 = sp.GetRequiredService<ILogger<LoggingMessageService>>();
    var currentUser = sp.GetRequiredService<ICurrentUserService>();

    // Build decoration chain — innermost first
    IMessageService cached = new CachingMessageService(core, cache, logger1);
    IMessageService logged = new LoggingMessageService(cached, logger2, currentUser);

    return logged; // Caller gets logged → cached → core
});

// ✅ Alternative: use Scrutor for cleaner decorator registration
// builder.Services.AddScoped<IMessageService, MessageService>();
// builder.Services.Decorate<IMessageService, CachingMessageService>();
// builder.Services.Decorate<IMessageService, LoggingMessageService>();
```

## The Trap

```csharp
// A senior developer correctly builds a decorator chain.
// Caching → Core. Logging → Caching → Core. Works perfectly. Ships.
// The trap: IMemoryCache in a multi-pod deployment — each pod has its own cache.

// Pod 1 caches message:abc = { content: "Hello" }
// User edits message on Pod 2 — content updated in DB to "Hello, World"
// Pod 1's cache still has "Hello" — serves stale content for 5 minutes
// User sees old message after editing. Files a bug. Looks like a write failure.

// Fix 1: use IDistributedCache (Redis) instead of IMemoryCache for shared state
public sealed class DistributedCachingMessageService(
    IMessageService inner,
    IDistributedCache cache,
    ILogger<DistributedCachingMessageService> logger) : IMessageService
{
    public async Task<MessageDto> GetByIdAsync(Guid id, CancellationToken ct)
    {
        var cached = await cache.GetStringAsync(CacheKey(id), ct);
        if (cached is not null)
            return JsonSerializer.Deserialize<MessageDto>(cached)!;

        var result = await inner.GetByIdAsync(id, ct);
        await cache.SetStringAsync(CacheKey(id),
            JsonSerializer.Serialize(result),
            new DistributedCacheEntryOptions
            {
                AbsoluteExpirationRelativeToNow = TimeSpan.FromMinutes(5)
            }, ct);

        return result;
    }

    public async Task<MessageDto> SendAsync(SendMessageRequest request, CancellationToken ct)
    {
        var result = await inner.SendAsync(request, ct);
        // Invalidate cache on write — consistency
        await cache.RemoveAsync(CacheKey(result.Id), ct);
        return result;
    }

    private static string CacheKey(Guid id) => $"message:{id}";
}
```

## The Exception
If the interface has many methods (10+) and the decorator only overrides one or two, consider whether a decorator is the right abstraction — the boilerplate of pass-through methods becomes noise that obscures the actual override. In this case, a MediatR pipeline behaviour (for request/response) or a domain event handler (for post-commit side effects) may be a cleaner cross-cutting mechanism. Use decorators when the behaviour applies to a specific service interface; use pipeline behaviours when it applies to all request handlers across the board.

## Before You Merge
- Does the decorator implement the same interface as the decorated service — not a subclass or concrete type?
- Is `IMemoryCache` replaced with `IDistributedCache` (Redis) in multi-pod deployments where cache consistency matters?
- Does the caching decorator invalidate cached entries on write operations — not just on cache expiry?
- Is the DI decoration order explicit and documented — outermost decorator registered last?
- Is each decorator single-responsibility — caching decorator does only caching, logging decorator does only logging?
