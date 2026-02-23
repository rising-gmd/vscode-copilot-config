# Rate Limiting
> Verified against: .NET 9 | C# 13 | System.Threading.RateLimiting 9.x
> Last reviewed: 2026-02-22

## The Law
Rate limit by authenticated user ID when available, fall back to IP address — never rate limit by IP alone on authenticated endpoints or a single NAT gateway blocks an entire office.

## Why This Kills You At Scale
An unprotected login endpoint at 100k users gets credential stuffed at 50,000 requests/minute from a botnet — your DB connection pool exhausts in 30 seconds, every authenticated user gets 503, and the attack logs look identical to legitimate traffic until you check the source IPs. A single missing rate limiter on a message send endpoint lets one abusive user send 10,000 messages/second and fills your DB in minutes.

## The Pattern

```csharp
#nullable enable
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.RateLimiting;

// ✅ Correct: in Program.cs — layered policies for different endpoint risk levels
builder.Services.AddRateLimiter(options =>
{
    options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;

    options.OnRejected = async (context, ct) =>
    {
        context.HttpContext.Response.StatusCode = 429;
        // Tell client when to retry — important for legitimate clients
        if (context.Lease.TryGetMetadata(MetadataName.RetryAfter, out var retryAfter))
        {
            context.HttpContext.Response.Headers.RetryAfter =
                ((int)retryAfter.TotalSeconds).ToString();
        }
        await context.HttpContext.Response.WriteAsJsonAsync(
            new { error = "Rate limit exceeded", retryAfter = retryAfter.TotalSeconds }, ct);
    };

    // ✅ Correct: partition by userId when authenticated, IP when not
    options.AddPolicy("auth-endpoints", context =>
    {
        var userId = context.User?.FindFirst(System.Security.Claims.ClaimTypes.NameIdentifier)?.Value;

        // Authenticated users: generous limit per user
        if (userId is not null)
        {
            return RateLimitPartition.GetSlidingWindowLimiter(
                partitionKey: $"user:{userId}",
                factory: _ => new SlidingWindowRateLimiterOptions
                {
                    PermitLimit = 100,
                    Window = TimeSpan.FromMinutes(1),
                    SegmentsPerWindow = 6, // 10-second buckets — smooth out bursts
                    AutoReplenishment = true
                });
        }

        // Unauthenticated: strict IP-based limit
        var ip = context.Connection.RemoteIpAddress?.ToString() ?? "unknown";
        return RateLimitPartition.GetFixedWindowLimiter(
            partitionKey: $"ip:{ip}",
            factory: _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = 10,
                Window = TimeSpan.FromMinutes(1),
                AutoReplenishment = true
            });
    });

    // ✅ Correct: strict policy for login — prevent credential stuffing
    options.AddPolicy("login", context =>
    {
        var ip = context.Connection.RemoteIpAddress?.ToString() ?? "unknown";
        return RateLimitPartition.GetFixedWindowLimiter(
            partitionKey: $"login:{ip}",
            factory: _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = 5,
                Window = TimeSpan.FromMinutes(1),
                AutoReplenishment = true
            });
    });

    // ✅ Correct: message sending — per user, sliding window
    options.AddPolicy("send-message", context =>
    {
        var userId = context.User?.FindFirst(System.Security.Claims.ClaimTypes.NameIdentifier)?.Value
            ?? context.Connection.RemoteIpAddress?.ToString()
            ?? "unknown";

        return RateLimitPartition.GetSlidingWindowLimiter(
            partitionKey: $"msg:{userId}",
            factory: _ => new SlidingWindowRateLimiterOptions
            {
                PermitLimit = 30,
                Window = TimeSpan.FromMinutes(1),
                SegmentsPerWindow = 6,
                AutoReplenishment = true
            });
    });
});

app.UseRateLimiter();

// ✅ Correct: apply per endpoint
[HttpPost("login")]
[EnableRateLimiting("login")]
public async Task<IActionResult> Login([FromBody] LoginRequest request, CancellationToken ct)
    => Ok(await _authService.LoginAsync(request.Identifier, request.Password, ct));

[HttpPost("messages")]
[EnableRateLimiting("send-message")]
public async Task<IActionResult> SendMessage([FromBody] SendMessageRequest request, CancellationToken ct)
    => Ok(await _messageService.SendAsync(request, ct));

// ❌ Wrong: rate limit by IP only on authenticated endpoint
options.AddPolicy("wrong", context =>
{
    // Everyone behind the same corporate NAT hits one shared limit
    // 500 employees sharing one IP — 499 get 429 after the first few requests
    var ip = context.Connection.RemoteIpAddress?.ToString() ?? "unknown";
    return RateLimitPartition.GetFixedWindowLimiter(ip,
        _ => new FixedWindowRateLimiterOptions { PermitLimit = 10, Window = TimeSpan.FromMinutes(1) });
});
```

## The Trap

```csharp
// A senior developer correctly implements rate limiting in Program.cs.
// Works perfectly in development. Silently does nothing in production.

// The trap: your app is behind a reverse proxy (nginx, Azure App Gateway, Cloudflare).
// context.Connection.RemoteIpAddress is always the proxy's IP — not the client's IP.
// Every user shares the same rate limit partition. First user hits limit, EVERYONE gets 429.

// Fix: configure forwarded headers BEFORE UseRateLimiter
app.UseForwardedHeaders(new ForwardedHeadersOptions
{
    ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto,
    // CRITICAL: only trust your known proxy IPs, not all proxies
    // Otherwise attackers spoof X-Forwarded-For to bypass rate limiting
    KnownProxies = { IPAddress.Parse("10.0.0.1") } // your actual proxy IP
});

app.UseRateLimiter(); // Now RemoteIpAddress is the real client IP

// Without KnownProxies restriction, an attacker sends:
// X-Forwarded-For: 1.2.3.4
// And bypasses your IP rate limit by rotating this header.
```

## The Exception
Internal service-to-service endpoints (health checks, metrics scrapers, deployment hooks) called by known infrastructure should use `[DisableRateLimiting]` — a Kubernetes liveness probe hitting a rate limit will cause your pods to restart in a cascading failure. Identify these endpoints explicitly and disable rate limiting by policy name, not globally.

## Before You Merge
- Does the rate limit partition key use authenticated user ID when the user is logged in?
- Is `UseForwardedHeaders` configured before `UseRateLimiter` when behind a reverse proxy?
- Are `KnownProxies` restricted to actual proxy IPs — not open to all forwarded headers?
- Does the 429 response include a `Retry-After` header so legitimate clients back off gracefully?
- Are health check and internal infrastructure endpoints explicitly excluded with `[DisableRateLimiting]`?
