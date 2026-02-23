# Idempotency Keys
> Verified against: .NET 9 | C# 13 | ASP.NET Core 9.x | StackExchange.Redis 2.x
> Last reviewed: 2026-02-22

## The Law
Every non-idempotent API operation (create, payment, send) must accept an `Idempotency-Key` header and return the same response for duplicate requests within the key's TTL.

## Why This Kills You At Scale
A mobile client sends a "send message" request. Network drops. Client retries. Your server receives both requests — two identical messages appear in the conversation. At 100k users on mobile connections where timeouts and retries are common, a missing idempotency implementation produces a continuous stream of duplicate messages, duplicate payments, and double-charged users. This is a 3am page triggered by billing support tickets.

## The Pattern

```csharp
#nullable enable
using StackExchange.Redis;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;

// ✅ Correct: idempotency filter using Redis for distributed state
public sealed class IdempotencyFilter(IConnectionMultiplexer redis, ILogger<IdempotencyFilter> logger)
    : IAsyncActionFilter
{
    private static readonly TimeSpan KeyTtl = TimeSpan.FromHours(24);
    private const string IdempotencyHeader = "Idempotency-Key";

    public async Task OnActionExecutionAsync(ActionExecutingContext context, ActionExecutionDelegate next)
    {
        // Only apply to POST/PUT/PATCH — GET/DELETE are inherently idempotent
        if (!HttpMethods.IsPost(context.HttpContext.Request.Method) &&
            !HttpMethods.IsPut(context.HttpContext.Request.Method))
        {
            await next();
            return;
        }

        var idempotencyKey = context.HttpContext.Request.Headers[IdempotencyHeader].FirstOrDefault();

        // ✅ If no key provided: allow through — don't force idempotency for optional usage
        if (string.IsNullOrWhiteSpace(idempotencyKey))
        {
            await next();
            return;
        }

        // Validate key format — prevent abuse with huge keys
        if (idempotencyKey.Length > 128)
        {
            context.Result = new BadRequestObjectResult(new { error = "Idempotency-Key exceeds maximum length" });
            return;
        }

        var db = redis.GetDatabase();
        var cacheKey = $"idempotency:{context.HttpContext.Request.Path}:{idempotencyKey}";

        // ✅ Check if we've seen this key before
        var cachedResponse = await db.StringGetAsync(cacheKey);

        if (cachedResponse.HasValue)
        {
            logger.LogInformation("Idempotent replay for key {Key}", idempotencyKey);
            var cached = System.Text.Json.JsonSerializer.Deserialize<CachedResponse>(cachedResponse!);

            // Return the exact same response as the original request
            context.Result = new ObjectResult(cached!.Body)
            {
                StatusCode = cached.StatusCode
            };
            context.HttpContext.Response.Headers.Append("X-Idempotency-Replayed", "true");
            return;
        }

        // ✅ Set a processing lock before executing — prevents concurrent duplicates
        var lockKey = $"idempotency:lock:{cacheKey}";
        var lockAcquired = await db.StringSetAsync(lockKey, "1", TimeSpan.FromSeconds(30),
            When.NotExists); // SET NX — atomic

        if (!lockAcquired)
        {
            // Another request with this key is currently processing
            context.Result = new ConflictObjectResult(
                new { error = "A request with this Idempotency-Key is currently being processed" });
            return;
        }

        try
        {
            var executedContext = await next();

            // Cache the response only on success (2xx)
            if (executedContext.Result is ObjectResult { StatusCode: >= 200 and < 300 } result)
            {
                var toCache = new CachedResponse(result.StatusCode ?? 200, result.Value);
                await db.StringSetAsync(cacheKey,
                    System.Text.Json.JsonSerializer.Serialize(toCache),
                    KeyTtl);
            }
        }
        finally
        {
            await db.KeyDeleteAsync(lockKey);
        }
    }
}

private sealed record CachedResponse(int StatusCode, object? Body);

// ✅ Correct: register as scoped filter
builder.Services.AddScoped<IdempotencyFilter>();

// ✅ Correct: apply to endpoints that need it
[HttpPost("messages")]
[ServiceFilter<IdempotencyFilter>]
public async Task<ActionResult<MessageDto>> SendMessage(
    [FromBody] SendMessageRequest request,
    CancellationToken ct)
{
    var message = await _messageService.CreateAsync(request, ct);
    return Ok(message);
}

// ❌ Wrong: application-level deduplication without atomic lock — race condition
public async Task<MessageDto> CreateMessageInsecureAsync(
    SendMessageRequest request, string idempotencyKey, CancellationToken ct)
{
    var existing = await _repo.GetByIdempotencyKeyAsync(idempotencyKey, ct);
    if (existing is not null) return existing.ToDto();
    // RACE: two requests arrive simultaneously — both find null, both insert
    // Result: duplicate messages despite idempotency key
    var message = new Message { IdempotencyKey = idempotencyKey };
    await _repo.AddAsync(message, ct);
    return message.ToDto();
}
```

## The Trap

```csharp
// A senior developer implements idempotency with Redis correctly.
// Works perfectly. Ships.
// The trap: idempotency keys are scoped to the wrong level.

// The developer scopes the cache key to just the idempotency key:
var cacheKey = $"idempotency:{idempotencyKey}";

// An attacker can replay a successful "send message" request to conversation A
// with the same idempotency key to conversation B:
// POST /api/conversations/conversationA/messages  Idempotency-Key: key-123 → success, cached
// POST /api/conversations/conversationB/messages  Idempotency-Key: key-123 → cache hit, replays response
// Message appears to be sent to B, but it was actually sent only to A.
// The attacker gets a false success response for conversation B.

// Fix: scope cache key to path + idempotency key + user ID
var userId = context.HttpContext.User.GetUserId();
var cacheKey = $"idempotency:{userId}:{context.HttpContext.Request.Path}:{idempotencyKey}";

// This ensures:
// 1. Same key used by different users creates separate cache entries
// 2. Same key used on different endpoints creates separate cache entries
// 3. Key cannot be replayed across different paths by an attacker
```

## The Exception
`GET`, `HEAD`, and `DELETE` requests are inherently idempotent by HTTP semantics — `GET` returns the same resource, `DELETE` is idempotent because deleting something twice has the same result as deleting it once. Do not implement idempotency keys for these methods. For `DELETE`, if the resource is already gone, return `404` — the client's intent (resource gone) is satisfied regardless.

## Before You Merge
- Is the idempotency cache key scoped to `userId + path + idempotency-key` — not just the raw key?
- Is the processing lock (`SET NX`) acquired before execution — not after — to prevent concurrent duplicate processing?
- Are idempotency keys bounded in length (e.g., 128 chars) to prevent Redis key abuse?
- Are only `2xx` responses cached — not errors (so a failed request can be retried with the same key)?
- Is the key TTL documented to the API consumer — so clients know how long replay is guaranteed?
