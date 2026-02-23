# Rate Limiting — Advanced
> Verified against: .NET 9 | C# 13 | System.Threading.RateLimiting 9.x | ASP.NET Core 9.x
> Last reviewed: 2026-02-22

## The Law
Layer rate limiting across three boundaries — the infrastructure edge (Azure Front Door / nginx), the application API gateway, and the in-process limiter — because any single layer can be circumvented or overwhelmed at billion-user scale.

## Why This Kills You At Scale
At one billion users, even a benign traffic spike — a celebrity joins the platform and 50 million users simultaneously hit their profile — can take down your database. Without layered rate limiting, 50 million requests per second reach your SQL Server simultaneously. Connection pool exhausts in 200ms. Every subsequent query times out. Platform is down for the majority of users for 30 minutes while you scale out. With proper rate limiting at edge → gateway → application, the spike is absorbed gracefully: edge throttles to 10,000 req/s per PoP, gateway throttles per-user, application limits per-endpoint. The celebrity moment becomes a success story, not an incident.

## The Pattern

```csharp
#nullable enable
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.RateLimiting;

// ✅ Correct: layered policies for different traffic patterns
builder.Services.AddRateLimiter(options =>
{
    options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;

    // ✅ Policy 1: Global API — coarse protection against abuse
    // Sliding window: user can burst to 200 but averaged over 10 seconds
    options.AddPolicy("Api", context =>
    {
        var userId = context.User?.FindFirst("sub")?.Value
                  ?? context.Connection.RemoteIpAddress?.ToString()
                  ?? "anonymous";

        return RateLimitPartition.GetSlidingWindowLimiter(
            partitionKey: $"api:{userId}",
            factory: _ => new SlidingWindowRateLimiterOptions
            {
                PermitLimit = 200,
                Window = TimeSpan.FromSeconds(10),
                SegmentsPerWindow = 5,         // 5 segments of 2s each — smooth enforcement
                QueueProcessingOrder = QueueProcessingOrder.OldestFirst,
                QueueLimit = 10                // 10 requests queue before 429
            });
    });

    // ✅ Policy 2: Message sending — tighter, per-conversation
    // Fixed window: 60 messages per minute per user — prevents spam floods
    options.AddPolicy("SendMessage", context =>
    {
        var userId = context.User?.FindFirst("sub")?.Value ?? "anonymous";
        var conversationId = context.GetRouteValue("conversationId")?.ToString() ?? "unknown";

        return RateLimitPartition.GetFixedWindowLimiter(
            partitionKey: $"msg:{userId}:{conversationId}",
            factory: _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = 60,
                Window = TimeSpan.FromMinutes(1),
                QueueProcessingOrder = QueueProcessingOrder.OldestFirst,
                QueueLimit = 5
            });
    });

    // ✅ Policy 3: Auth endpoints — very tight, IP-partitioned
    // Concurrency limiter: max 3 simultaneous auth requests per IP
    options.AddPolicy("Auth", context =>
    {
        var ip = context.Connection.RemoteIpAddress?.ToString() ?? "unknown";

        return RateLimitPartition.GetTokenBucketLimiter(
            partitionKey: $"auth:{ip}",
            factory: _ => new TokenBucketRateLimiterOptions
            {
                TokenLimit = 10,
                QueueProcessingOrder = QueueProcessingOrder.OldestFirst,
                QueueLimit = 0,              // No queue — instant 429 for auth floods
                ReplenishmentPeriod = TimeSpan.FromMinutes(1),
                TokensPerPeriod = 5,
                AutoReplenishment = true
            });
    });

    // ✅ Policy 4: Expensive endpoints (search, exports)
    // Concurrency limiter: max 2 simultaneous per user
    options.AddPolicy("Expensive", context =>
    {
        var userId = context.User?.FindFirst("sub")?.Value ?? "anonymous";

        return RateLimitPartition.GetConcurrencyLimiter(
            partitionKey: $"expensive:{userId}",
            factory: _ => new ConcurrencyLimiterOptions
            {
                PermitLimit = 2,       // Max 2 concurrent expensive operations per user
                QueueProcessingOrder = QueueProcessingOrder.OldestFirst,
                QueueLimit = 1         // One in queue — third gets 429
            });
    });

    // ✅ Correct: Retry-After header on rejection
    options.OnRejected = async (context, token) =>
    {
        context.HttpContext.Response.StatusCode = StatusCodes.Status429TooManyRequests;

        if (context.Lease.TryGetMetadata(
            MetadataName.RetryAfter, out var retryAfter))
        {
            context.HttpContext.Response.Headers.RetryAfter =
                ((int)retryAfter.TotalSeconds).ToString();
        }

        await context.HttpContext.Response.WriteAsJsonAsync(new ProblemDetails
        {
            Status = 429,
            Title = "RATE_LIMIT_EXCEEDED",
            Detail = "Too many requests. Please slow down."
        }, token);
    };
});

// ✅ Correct: apply policies to endpoints
app.UseRateLimiter();

// In controllers:
[HttpPost("login")]
[RateLimiting("Auth")]
public async Task<IActionResult> Login(LoginRequest request, CancellationToken ct) { }

[HttpPost("conversations/{conversationId:guid}/messages")]
[RateLimiting("SendMessage")]
[RateLimiting("Api")]
public async Task<IActionResult> SendMessage(
    Guid conversationId,
    [FromBody] SendMessageRequest request,
    CancellationToken ct) { }

[HttpGet("search/users")]
[RateLimiting("Expensive")]
[RateLimiting("Api")]
public async Task<IActionResult> SearchUsers(
    [FromQuery] string q,
    CancellationToken ct) { }

// ✅ Correct: Redis-backed distributed rate limiting for multi-pod consistency
// Built-in ASP.NET Core rate limiting is per-process — each pod has its own counter
// User sends 190 requests to Pod 1 and 190 to Pod 2 = 380 requests, limit bypassed

// For distributed enforcement, use RedisRateLimiter (community package) or
// implement via Redis INCR + EXPIRE:
public sealed class RedisRateLimiter(IConnectionMultiplexer redis)
{
    public async Task<bool> IsAllowedAsync(
        string key,
        int limit,
        TimeSpan window,
        CancellationToken ct)
    {
        var db = redis.GetDatabase();
        var redisKey = $"ratelimit:{key}";

        var transaction = db.CreateTransaction();
        var incrTask = transaction.StringIncrementAsync(redisKey);
        var expireTask = transaction.KeyExpireAsync(redisKey, window, ExpireWhen.HasNoExpiry);

        await transaction.ExecuteAsync();
        var count = await incrTask;

        return count <= limit;
    }
}
```

## The Trap

```csharp
// A senior developer correctly implements per-user sliding window limits.
// Policies apply to all relevant endpoints. Retry-After headers present. Ships.
// The trap: X-Forwarded-For spoofing bypasses IP-based rate limiting.

// Scenario: attacker sends requests with header:
// X-Forwarded-For: 1.2.3.4, 5.6.7.8, 9.10.11.12
// Your rate limiter reads HttpContext.Connection.RemoteIpAddress — this is the
// load balancer's IP, not the client's. So all 50 million users appear to come
// from IP 10.0.0.1 (the load balancer). Rate limiting by IP is completely broken.

// Or worse: your code reads Request.Headers["X-Forwarded-For"].ToString()
// The attacker rotates this header value per request — effectively no IP rate limiting.

// Fix: configure ForwardedHeaders middleware FIRST, then rate limit on the resolved IP
builder.Services.Configure<ForwardedHeadersOptions>(options =>
{
    options.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto;
    options.KnownNetworks.Clear();   // Remove defaults
    options.KnownProxies.Clear();

    // ✅ Only trust X-Forwarded-For from YOUR known load balancers
    // Add your Azure Front Door / nginx egress IPs explicitly
    options.KnownProxies.Add(IPAddress.Parse("10.0.0.1")); // Load balancer IP
    options.KnownProxies.Add(IPAddress.Parse("10.0.0.2")); // Load balancer IP 2

    // Limit the chain — only take the last N proxies (prevents injection via appended IPs)
    options.ForwardLimit = 2;
});

app.UseForwardedHeaders(); // MUST be before UseRateLimiter
app.UseRateLimiter();

// Now HttpContext.Connection.RemoteIpAddress is the real client IP — not the load balancer
// Spoofed X-Forwarded-For headers from untrusted sources are ignored
```

## The Exception
Internal service-to-service calls (Hangfire workers calling the API, admin health checks, internal microservice clients) should be explicitly exempted from rate limiting via a policy that allows unlimited requests for known internal IPs or service accounts with a specific claim. Rate limiting internal traffic causes cascading failures when a legitimate background process hits the limit and starts dropping work.

## Before You Merge
- Is `UseForwardedHeaders()` registered before `UseRateLimiter()` — ensuring real client IPs, not load balancer IPs, are used for IP-based partitions?
- Is `ForwardLimit` set to the exact number of trusted proxies in your infrastructure — not left at unlimited?
- Is the `Retry-After` header set in `OnRejected` — so well-behaved clients back off automatically?
- Are auth endpoints (`/login`, `/register`, `/reset-password`) on the tightest token bucket policy — not the general sliding window?
- Is a Redis-backed distributed limiter in place for multi-pod deployments — not per-process counting that is easily bypassed by hitting different pods?
