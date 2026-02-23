# Caching Strategy
> Verified against: .NET 9 | C# 13 | Microsoft.Extensions.Caching.Hybrid 9.x | StackExchange.Redis 2.x
> Last reviewed: 2026-02-22

## The Law
Cache at the right layer for the right duration — L1 in-process for immutable reference data, L2 distributed (Redis) for shared mutable state, and never cache data that carries per-user authorization context in a shared cache.

## Why This Kills You At Scale
At one billion users, even a 1ms database query run on every request destroys throughput. But the wrong cache strategy kills you differently: caching a user's conversation list in a shared Redis key without a user-scoped key means User A sees User B's conversations — a catastrophic data leak that passes every functional test because test environments never test with concurrent different users hitting the same key. Cache poisoning and stale authorization data at billion-user scale are existential incidents.

## The Pattern

```csharp
#nullable enable
using Microsoft.Extensions.Caching.Hybrid;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Caching.Distributed;

// ✅ Correct: HybridCache — .NET 9's two-level cache (L1 in-process + L2 Redis)
// Eliminates the thundering herd problem that IDistributedCache has:
// Multiple simultaneous cache misses all hit the DB — HybridCache serialises them
builder.Services.AddHybridCache(options =>
{
    options.MaximumPayloadBytes = 1024 * 1024; // 1MB max per entry
    options.MaximumKeyLength = 1024;
    options.DefaultEntryOptions = new HybridCacheEntryOptions
    {
        Expiration = TimeSpan.FromMinutes(5),          // L2 Redis TTL
        LocalCacheExpiration = TimeSpan.FromSeconds(30) // L1 in-process TTL
    };
});

// Register Redis as the L2 backend
builder.Services.AddStackExchangeRedisCache(options =>
    options.Configuration = builder.Configuration.GetConnectionString("Redis"));

public sealed class ConversationCacheService(
    HybridCache hybridCache,
    IDapperConversationRepository repo,
    ILogger<ConversationCacheService> logger)
{
    // ✅ Correct: user-scoped cache key — NEVER share per-user data across users
    private static string ConversationListKey(Guid userId)
        => $"conversations:v2:{userId}"; // Version prefix for easy cache busting

    private static string ConversationKey(Guid conversationId)
        => $"conversation:v2:{conversationId}";

    // ✅ Correct: HybridCache.GetOrCreateAsync — stampede-safe
    // If 1000 requests miss simultaneously, only ONE hits the DB
    // The other 999 wait for the first result and receive it
    public async Task<IReadOnlyList<ConversationSummaryDto>> GetUserConversationsAsync(
        Guid userId,
        CancellationToken ct)
    {
        return await hybridCache.GetOrCreateAsync(
            ConversationListKey(userId),
            async cancel => await repo.GetForUserAsync(userId, cancel),
            new HybridCacheEntryOptions
            {
                Expiration = TimeSpan.FromMinutes(2),          // List changes frequently
                LocalCacheExpiration = TimeSpan.FromSeconds(10) // Short L1 for freshness
            },
            cancellationToken: ct);
    }

    // ✅ Correct: immutable conversation metadata — longer TTL
    public async Task<ConversationDto?> GetConversationAsync(
        Guid conversationId,
        CancellationToken ct)
    {
        return await hybridCache.GetOrCreateAsync(
            ConversationKey(conversationId),
            async cancel => await repo.GetByIdAsync(conversationId, cancel),
            new HybridCacheEntryOptions
            {
                Expiration = TimeSpan.FromMinutes(15),         // Metadata rarely changes
                LocalCacheExpiration = TimeSpan.FromMinutes(1)
            },
            cancellationToken: ct);
    }

    // ✅ Correct: invalidate on write — consistency over freshness
    public async Task InvalidateUserConversationsAsync(Guid userId, CancellationToken ct)
    {
        await hybridCache.RemoveAsync(ConversationListKey(userId), ct);
        logger.LogDebug("Invalidated conversation list cache for user {UserId}", userId);
    }

    public async Task InvalidateConversationAsync(Guid conversationId, CancellationToken ct)
    {
        await hybridCache.RemoveAsync(ConversationKey(conversationId), ct);
    }
}

// ✅ Correct: cache-aside in service — invalidate after writes
public sealed class ConversationService(
    IConversationRepository repo,
    IUnitOfWork unitOfWork,
    ConversationCacheService cache,
    IRealTimeNotifier notifier)
{
    public async Task<MessageDto> SendMessageAsync(
        Guid conversationId,
        string content,
        CancellationToken ct)
    {
        var message = await CreateMessageAsync(conversationId, content, ct);

        // Invalidate AFTER successful write — not before
        await cache.InvalidateUserConversationsAsync(message.SenderId, ct);

        await notifier.NotifyMessageSentAsync(conversationId, message, ct);
        return message;
    }
}

// ✅ Correct: reference data — long TTL, shared across all users (safe — no user context)
public sealed class EmojiCacheService(HybridCache cache, IEmojiRepository repo)
{
    private const string Key = "emojis:v1:all"; // No user scope — emoji list is global

    public async Task<IReadOnlyList<EmojiDto>> GetAllAsync(CancellationToken ct)
        => await cache.GetOrCreateAsync(
            Key,
            async cancel => await repo.GetAllAsync(cancel),
            new HybridCacheEntryOptions
            {
                Expiration = TimeSpan.FromHours(24),     // Emojis never change
                LocalCacheExpiration = TimeSpan.FromHours(1)
            },
            cancellationToken: ct);
}

// ❌ Wrong: non-user-scoped key for user data — data leak
public async Task<IReadOnlyList<ConversationSummaryDto>> GetConversationsWrongAsync(
    Guid userId, CancellationToken ct)
{
    // "conversations:all" — every user gets the SAME cached list
    return await hybridCache.GetOrCreateAsync(
        "conversations:all", // CATASTROPHIC: User A's data served to User B
        async _ => await repo.GetForUserAsync(userId, ct));
}

// ❌ Wrong: no invalidation on write — stale data for TTL duration
public async Task AddParticipantWrongAsync(Guid conversationId, Guid userId)
{
    await repo.AddParticipantAsync(conversationId, userId);
    await unitOfWork.SaveChangesAsync();
    // No cache invalidation — user won't see updated participant list for up to 15 minutes
}
```

## The Trap

```csharp
// A senior developer correctly scopes cache keys per user, invalidates on write.
// HybridCache handles stampedes. Ships to staging.
// The trap: cache key versioning is missing — deployments serve stale serialized types.

// Scenario: deploy ships new MessageDto with added field "ReactionCount".
// Redis still has old serialized MessageDto objects without "ReactionCount".
// HybridCache deserializes them — ReactionCount is 0 (default) for all cached entries.
// Users see zero reactions on all messages for up to 15 minutes post-deploy.
// Worse: if the old format is binary-incompatible, every cache hit throws
// SerializationException — 100% cache miss rate under load for the first 15 minutes.
// Your DB, designed for cache-assisted load, receives 10x normal traffic.

// Fix 1: version prefix in ALL cache keys — bump version on every DTO change
private static string ConversationKey(Guid id) => $"conversation:v3:{id}"; // v2 → v3 on deploy

// Fix 2: on deployment, flush the relevant key pattern before starting new pods
// In CI/CD pipeline pre-deploy step:
// redis-cli SCAN 0 MATCH "conversation:v2:*" COUNT 1000 | xargs redis-cli DEL

// Fix 3: use JSON serialization (not binary) for Redis — tolerates missing fields gracefully
builder.Services.AddStackExchangeRedisCache(options =>
{
    options.Configuration = builder.Configuration.GetConnectionString("Redis");
    // JSON is forward-compatible: new fields default to null, missing fields are ignored
    // Binary (protobuf, MessagePack) is NOT forward-compatible without careful versioning
});

// Fix 4: short TTL on frequently-changing DTOs — accept staleness window over serialization risk
new HybridCacheEntryOptions
{
    Expiration = TimeSpan.FromMinutes(1), // Short enough that deployment window is acceptable
}
```

## The Exception
Write-heavy data that changes on every request — typing indicators, live cursor positions, unread counts updated per-message — should NOT be cached. The cost of invalidation on every write exceeds the benefit of caching. For these: use Redis pub/sub or SignalR for real-time delivery, and accept a DB read for the authoritative state. Cache only data where reads significantly outnumber writes. At billion-user scale, conversation metadata (rarely changes) is ideal. Per-message unread counts (changes on every message read) is not.

## Before You Merge
- Is every user-specific cache key scoped with a userId — never a shared key serving user-specific data?
- Does every write operation that affects cached data call the corresponding invalidation method?
- Are cache keys versioned (`v1:`, `v2:`) — so deployments with changed DTO shapes do not serve corrupt deserialized data?
- Is `HybridCache.GetOrCreateAsync` used — not `IDistributedCache.GetAsync` + separate DB call which has stampede vulnerability?
- Are immutable reference data (emoji lists, config, feature flags) cached with long TTLs (hours) — not the same TTL as user-specific mutable data (minutes)?
