# Output Caching
> Verified against: .NET 9 | C# 13 | ASP.NET Core 9.x | Microsoft.Extensions.Caching.StackExchangeRedis 9.x
> Last reviewed: 2026-02-22

## The Law
Cache the HTTP response at the output level for public, infrequently-changing endpoints — and tag every cache entry so it can be invalidated precisely when the underlying data changes.

## Why This Kills You At Scale
A public API endpoint serving conversation list to 100k users without output caching hits your DB on every request — at 1,000 requests/second, your DB handles 1,000 identical queries per second for data that changes once per minute. Output caching with a 60-second TTL reduces that to 1 query per minute. Tag-based invalidation ensures users see fresh data the moment it changes, without waiting for TTL expiry — which matters for a chat app where "stale" means missed messages.

## The Pattern

```csharp
#nullable enable
using Microsoft.AspNetCore.OutputCaching;

// ✅ Correct: register output cache with Redis backing (production)
builder.Services.AddOutputCache(options =>
{
    // ✅ Named policies — reusable, documented
    options.AddPolicy("ShortCache", policy =>
        policy
            .Expire(TimeSpan.FromSeconds(30))
            .SetVaryByQuery("cursor", "pageSize") // Different cache entry per query string
            .Tag("conversations"));               // Tag for targeted invalidation

    options.AddPolicy("UserSpecific", policy =>
        policy
            .Expire(TimeSpan.FromSeconds(60))
            .SetVaryByHeader("Authorization")     // Different cache per user
            .SetVaryByQuery("cursor", "pageSize")
            .Tag("user-data"));

    // ✅ Default: no caching — must opt in explicitly
    options.DefaultExpirationTimeSpan = TimeSpan.Zero;
});

// ✅ Correct: Redis as distributed output cache (required for multi-instance)
builder.Services.AddStackExchangeRedisOutputCache(options =>
{
    options.Configuration = builder.Configuration.GetConnectionString("Redis");
    options.InstanceName = "OutputCache:";
});

app.UseOutputCache(); // After UseRouting, before MapControllers

// ✅ Correct: apply per endpoint
[HttpGet]
[OutputCache(PolicyName = "ShortCache")]
public async Task<ActionResult<PagedResult<ConversationDto>>> GetAll(
    [FromQuery] string? cursor,
    [FromQuery] int pageSize = 20,
    CancellationToken ct = default)
{
    return Ok(await _conversationService.GetPagedAsync(cursor, pageSize, ct));
}

// ✅ Correct: tag-based invalidation when data changes
[HttpPost]
public async Task<ActionResult<ConversationDto>> Create(
    [FromBody] CreateConversationRequest request,
    [FromServices] IOutputCacheStore cacheStore,
    CancellationToken ct)
{
    var conversation = await _conversationService.CreateAsync(request, ct);

    // ✅ Invalidate all entries tagged "conversations" — ensures fresh data immediately
    await cacheStore.EvictByTagAsync("conversations", ct);

    return CreatedAtAction(nameof(GetById), new { id = conversation.Id }, conversation);
}

// ✅ Correct: authenticated user cache — vary by user identity
[HttpGet("my-profile")]
[Authorize]
[OutputCache(PolicyName = "UserSpecific", Duration = 60)]
public async Task<ActionResult<UserProfileDto>> GetMyProfile(CancellationToken ct)
{
    var userId = User.GetUserId();
    return Ok(await _userService.GetProfileAsync(userId, ct));
}

// ✅ Correct: programmatic invalidation in service layer
public sealed class ConversationService(IOutputCacheStore cacheStore)
{
    public async Task UpdateTitleAsync(Guid id, string newTitle, CancellationToken ct)
    {
        await _repo.UpdateTitleAsync(id, newTitle, ct);
        // Tag-based: only conversations cache is invalidated, not user profiles
        await cacheStore.EvictByTagAsync("conversations", ct);
    }
}

// ❌ Wrong: caching authenticated, user-specific responses without VaryByHeader
[HttpGet("my-conversations")]
[Authorize]
[OutputCache(Duration = 60)] // BUG: All users get the same cached response
public async Task<IActionResult> GetMyConversations(CancellationToken ct)
{
    return Ok(await _service.GetForUserAsync(User.GetUserId(), ct));
}
```

## The Trap

```csharp
// A senior developer implements output caching with tag-based invalidation.
// Works perfectly in single-instance development.
// The trap: in-memory output cache (default) is NOT shared across instances.

// Instance 1: caches conversation list, tagged "conversations"
// User creates new conversation → hits Instance 2
// Instance 2: EvictByTagAsync("conversations") evicts only Instance 2's cache
// Instance 1: still serves stale data from its own in-memory cache
// Users see different data depending on which instance they hit

// Fix: always use Redis-backed output cache in multi-instance production
// builder.Services.AddStackExchangeRedisOutputCache(...) — not just AddOutputCache()

// Second trap: output caching and SetVaryByHeader("Authorization") interaction.
// When a user logs out and a new user logs in with a different token,
// the Authorization header changes — correct, different cache entry.
// But if your auth is cookie-based (not Authorization header),
// you must use SetVaryByHeader("Cookie") or a custom vary policy.

// Custom vary by user ID from cookie:
options.AddPolicy("CookieUserSpecific", policy =>
    policy
        .AddPolicy<UserIdVaryByPolicy>() // Custom IOutputCachePolicy
        .Expire(TimeSpan.FromSeconds(60))
        .Tag("user-data"));

public sealed class UserIdVaryByPolicy : IOutputCachePolicy
{
    public ValueTask CacheRequestAsync(OutputCacheContext context, CancellationToken ct)
    {
        var userId = context.HttpContext.User.FindFirstValue(
            System.Security.Claims.ClaimTypes.NameIdentifier);
        if (userId is not null)
            context.CacheVaryByValues.Add("userId", userId);
        return ValueTask.CompletedTask;
    }

    public ValueTask ServeFromCacheAsync(OutputCacheContext context, CancellationToken ct)
        => ValueTask.CompletedTask;

    public ValueTask ServeResponseAsync(OutputCacheContext context, CancellationToken ct)
        => ValueTask.CompletedTask;
}
```

## The Exception
Real-time endpoints (chat messages, presence status, live notifications) must never be output cached — the data changes within seconds and staleness is the core UX failure. Similarly, any endpoint that returns personalized data influenced by server-side state that changes frequently (unread count, notification badge) should use short TTLs (5-10 seconds) or no caching — not minute-level cache durations that make the UI feel unresponsive.

## Before You Merge
- Is `AddStackExchangeRedisOutputCache` configured for production — not in-memory-only output cache?
- Does every cached endpoint that serves user-specific data have a `SetVaryByHeader` or custom vary policy?
- Is every write operation that changes cached data followed by `EvictByTagAsync` with the relevant tag?
- Are real-time or frequently-changing endpoints explicitly excluded from output caching (`[OutputCache(NoStore = true)]`)?
- Is `app.UseOutputCache()` placed after `UseAuthentication()` — so the user identity is available for vary policies?
