# Output Caching — Advanced
> Verified against: .NET 9 | C# 13 | ASP.NET Core 9.x
> Last reviewed: 2026-02-22

## The Law
Cache full HTTP responses at the output level for public, high-traffic, low-personalization endpoints — never apply output caching to endpoints with per-user personalization, authentication-dependent content, or state-changing operations.

## Why This Kills You At Scale
At one billion users, an emoji list endpoint, a public user profile page, or a list of trending conversations are requested billions of times per day — identical content for every caller. Without output caching, every request executes middleware, authorization, service, repository, and database round-trip: 200ms of compute per request, all for identical bytes. With output caching: first request pays 200ms, subsequent 999,999,999 requests pay 2ms — a 100x reduction in compute cost for that endpoint family.

## The Pattern

```csharp
#nullable enable
using Microsoft.AspNetCore.OutputCaching;

// ✅ Correct: register output caching with Redis for multi-pod consistency
// Without Redis: each pod has its own output cache — pod B misses pod A's cached response
// With Redis: all pods share the same output cache — cache population is global
builder.Services.AddOutputCache(options =>
{
    // ✅ Named policies — reuse across multiple endpoints
    options.AddPolicy("Static", build =>
        build.Expire(TimeSpan.FromHours(24))
             .SetVaryByHeader("Accept-Encoding") // Different cache for br vs gzip
             .Tag("static")); // Tag for targeted invalidation

    options.AddPolicy("PublicProfile", build =>
        build.Expire(TimeSpan.FromMinutes(5))
             .SetVaryByRouteValue("userId")    // Cache per userId in URL
             .SetVaryByHeader("Accept-Encoding")
             .Tag("user-profile"));

    options.AddPolicy("TrendingConversations", build =>
        build.Expire(TimeSpan.FromSeconds(30)) // Short TTL — trending changes fast
             .SetVaryByQuery("region")          // Cache per region query param
             .Tag("trending"));
});

// ✅ Register Redis as output cache store — shared across all pods
builder.Services.AddStackExchangeRedisOutputCache(options =>
    options.Configuration = builder.Configuration.GetConnectionString("Redis"));

// ✅ Middleware position — after auth, before controllers
app.UseAuthentication();
app.UseAuthorization();
app.UseOutputCache(); // After auth — can conditionally cache based on auth state
app.MapControllers();

// ✅ Correct: static reference data — maximum benefit, zero personalization
[HttpGet("emojis")]
[OutputCache(PolicyName = "Static")]
[AllowAnonymous]
public async Task<IActionResult> GetEmojis(CancellationToken ct)
{
    // ✅ This runs once per 24 hours per pod (or globally with Redis)
    // The remaining billions of requests are served from cache
    var emojis = await _emojiService.GetAllAsync(ct);
    return Ok(ApiResponse.Ok(emojis));
}

// ✅ Correct: public user profiles — cached per userId, short TTL
[HttpGet("users/{userId:guid}/profile")]
[OutputCache(PolicyName = "PublicProfile")]
[AllowAnonymous]
public async Task<IActionResult> GetPublicProfile(Guid userId, CancellationToken ct)
{
    var profile = await _userService.GetPublicProfileAsync(userId, ct)
        ?? throw new NotFoundException("User not found");
    return Ok(ApiResponse.Ok(profile));
}

// ✅ Correct: targeted cache invalidation — evict by tag when data changes
public sealed class UserProfileService(
    IUserRepository repo,
    IOutputCacheStore cacheStore,
    IUnitOfWork unitOfWork) : IUserProfileService
{
    public async Task UpdateProfileAsync(
        Guid userId,
        UpdateProfileRequest request,
        CancellationToken ct)
    {
        var user = await repo.GetByIdAsync(userId, ct)
            ?? throw new NotFoundException("User not found");

        user.UpdateProfile(request.DisplayName, request.Bio, request.ProfilePictureUrl);
        await unitOfWork.SaveChangesAsync(ct);

        // ✅ Invalidate the cached public profile — all pods via Redis store
        await cacheStore.EvictByTagAsync("user-profile", ct);
        // For more targeted eviction — if the tag includes the userId:
        // await cacheStore.EvictByTagAsync($"user-profile:{userId}", ct);
    }
}

// ✅ Correct: vary by auth state — authenticated users get uncached, anonymous get cached
[HttpGet("conversations/trending")]
[OutputCache(PolicyName = "TrendingConversations")]
public async Task<IActionResult> GetTrending(
    [FromQuery] string? region,
    CancellationToken ct)
{
    // ✅ This endpoint has no per-user personalization — same for all callers
    var trending = await _conversationService.GetTrendingAsync(region, ct);
    return Ok(ApiResponse.Ok(trending));
}

// ❌ Wrong: output caching a per-user endpoint
[HttpGet("conversations")] // Returns THIS user's conversations
[OutputCache(Duration = 60)] // CATASTROPHIC: User A's conversations served to User B
[Authorize]
public async Task<IActionResult> GetMyConversations(CancellationToken ct)
{
    var userId = _currentUser.GetUserId();
    var convs = await _service.GetForUserAsync(userId, ct);
    return Ok(convs);
}

// ❌ Wrong: output caching a POST endpoint
[HttpPost("messages")]
[OutputCache(Duration = 10)] // Nonsensical: POST responses should never be cached
public async Task<IActionResult> Send([FromBody] SendMessageRequest req, CancellationToken ct)
{
    var message = await _service.SendAsync(req, ct);
    return Created(message);
}
```

## The Trap

```csharp
// A senior developer correctly applies output caching to static and public endpoints.
// User-specific endpoints excluded. Ships.
// The trap: the Cache-Control response header conflicts with output caching.

// Scenario: frontend adds Cache-Control: no-cache to request headers for freshness.
// ASP.NET Core's output cache respects Cache-Control: no-cache from the client —
// it bypasses the cache and always hits the server. At billion-user scale,
// an Angular app that sends Cache-Control: no-cache with every request (a common
// HttpClient interceptor pattern) renders your entire output caching infrastructure useless.

// The symptom: output cache hit rate shows 0% in monitoring.
// Every request is a cache miss. DB is hammered. No errors. Just wasted compute.

// Fix 1: in the output cache policy, lock the cache from client bypass
options.AddPolicy("Static", build =>
    build.Expire(TimeSpan.FromHours(24))
         .SetVaryByHeader("Accept-Encoding")
         .NoLock(false)  // ✅ Prevents client Cache-Control from bypassing cache
         .Tag("static"));

// Fix 2: on the Angular side, fix the interceptor to NOT send Cache-Control: no-cache
// for GET requests to API endpoints — only for authenticated, mutable resource endpoints.
// The root cause is usually an HttpClient interceptor added for auth that adds
// no-cache headers universally. Scope it to POST/PUT/DELETE only.

// Fix 3: if you cannot control client headers (third-party integrations),
// use a custom IOutputCachePolicy that ignores client cache directives:
public sealed class IgnoreClientCachePolicy : IOutputCachePolicy
{
    public ValueTask CacheRequestAsync(OutputCacheContext context, CancellationToken ct)
    {
        context.AllowCacheLookup = true;
        context.AllowCacheStorage = true;
        context.AllowLocking = true;
        // Ignore client's Cache-Control header entirely for this policy
        return ValueTask.CompletedTask;
    }

    public ValueTask ServeFromCacheAsync(OutputCacheContext context, CancellationToken ct)
        => ValueTask.CompletedTask;

    public ValueTask ServeResponseAsync(OutputCacheContext context, CancellationToken ct)
    {
        context.ShouldCacheResponse = true;
        return ValueTask.CompletedTask;
    }
}
```

## The Exception
`[OutputCache]` is wrong for any endpoint that: (1) reads the authenticated user's identity to personalize results, (2) returns data that changes per-request (idempotency tokens, CSRF tokens, nonces), or (3) performs side effects on GET (analytics write-backs, view counters that must be exact). For these, use `IHybridCache` (application-level, scoped-key caching) instead of output caching (HTTP-level, URL-keyed caching).

## Before You Merge
- Are all `[OutputCache]` applied endpoints verified to return identical content for every caller — no per-user personalization?
- Is `NoLock(false)` set on all output cache policies — preventing client `Cache-Control: no-cache` from bypassing the cache?
- Is Redis registered as the output cache store — so cache populations are shared across all pods?
- Are POST, PUT, PATCH, DELETE endpoints explicitly excluded from output caching?
- Does cache invalidation use `IOutputCacheStore.EvictByTagAsync()` — not TTL expiry alone — for correctness after writes?
