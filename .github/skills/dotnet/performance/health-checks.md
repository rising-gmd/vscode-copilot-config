# Health Checks
> Verified against: .NET 9 | C# 13 | Microsoft.Extensions.Diagnostics.HealthChecks 9.x
> Last reviewed: 2026-02-22

## The Law
Expose three distinct health endpoints — `/health/live` (is the process alive), `/health/ready` (can it serve traffic), and `/health/startup` (has it finished initialising) — and use them correctly in your Kubernetes pod spec; confusing readiness with liveness causes cascading pod restart loops that take down the entire cluster.

## Why This Kills You At Scale
At one billion users across 500 pods, a misconfigured health check causes a pod restart storm. The scenario: your liveness probe calls `/health/ready` which checks Redis connectivity. Redis has a 5-second blip. 500 pods simultaneously fail their liveness probe. Kubernetes kills all 500 pods and starts replacing them. The new pods start, immediately try to connect to Redis (which recovered but is now overwhelmed by 500 simultaneous reconnect attempts), and fail their startup probes. Kubernetes cycles them again. Your platform is down for 20 minutes during what should have been a 5-second Redis hiccup. Correct health check separation prevents this entirely.

## The Pattern

```csharp
#nullable enable
using Microsoft.Extensions.Diagnostics.HealthChecks;

// ✅ Correct: three-tier health check configuration
builder.Services
    .AddHealthChecks()

    // ✅ Readiness — can this pod serve traffic?
    // Fails if critical dependencies are unreachable
    .AddSqlServer(
        connectionString: builder.Configuration.GetConnectionString("Default")!,
        healthQuery: "SELECT 1",
        name: "sql-server",
        failureStatus: HealthStatus.Unhealthy,
        tags: ["ready", "db"])

    .AddRedis(
        redisConnectionString: builder.Configuration.GetConnectionString("Redis")!,
        name: "redis",
        failureStatus: HealthStatus.Unhealthy,
        tags: ["ready", "cache"])

    // ✅ Degraded — can serve but at reduced capability
    .AddUrlGroup(
        uri: new Uri("https://email-provider.com/health"),
        name: "email-provider",
        failureStatus: HealthStatus.Degraded, // Degraded — not Unhealthy
        tags: ["ready", "external"]) // Email outage ≠ remove pod from load balancer

    // ✅ Liveness — is the process healthy (not deadlocked / OOMing)
    // ONLY checks in-process state — never external dependencies
    .AddCheck("liveness", () =>
    {
        // Check thread pool health
        ThreadPool.GetAvailableThreads(out var workerThreads, out var ioThreads);
        ThreadPool.GetMaxThreads(out var maxWorker, out _);

        var utilizationPct = 100 - (workerThreads * 100 / maxWorker);

        return utilizationPct > 90
            ? HealthCheckResult.Unhealthy(
                $"Thread pool {utilizationPct}% utilized — possible starvation")
            : HealthCheckResult.Healthy($"Thread pool OK ({utilizationPct}% utilized)");
    }, tags: ["live"])

    // ✅ Custom health check — application-level invariant
    .AddCheck<MessageQueueDepthCheck>(
        "message-queue-depth",
        failureStatus: HealthStatus.Degraded,
        tags: ["ready"]);

// ✅ Three separate endpoints — Kubernetes uses each for a different purpose
app.MapHealthChecks("/health/live", new HealthCheckOptions
{
    // Liveness: only in-process checks — NEVER Redis/DB
    // If this fails, Kubernetes KILLS the pod
    // Never check external dependencies here — Redis blip would kill 500 pods
    Predicate = check => check.Tags.Contains("live"),
    ResponseWriter = WriteHealthResponse
});

app.MapHealthChecks("/health/ready", new HealthCheckOptions
{
    // Readiness: SQL + Redis + critical deps
    // If this fails, Kubernetes REMOVES pod from load balancer (does not kill it)
    // Pod recovers and is added back when deps recover
    Predicate = check => check.Tags.Contains("ready"),
    ResponseWriter = WriteHealthResponse
})
.RequireHost("*:8080"); // ✅ Health endpoint on separate port — not exposed externally

app.MapHealthChecks("/health/startup", new HealthCheckOptions
{
    // Startup: all checks — confirms pod fully initialised before any traffic
    // If this fails, Kubernetes does NOT route traffic — pod stays "initialising"
    // Allows slow startup (migration, cache warm-up) without liveness restarts
    Predicate = _ => true,
    ResponseWriter = WriteHealthResponse
});

// ✅ Correct: custom health check implementation
public sealed class MessageQueueDepthCheck(
    IConnectionMultiplexer redis,
    ILogger<MessageQueueDepthCheck> logger) : IHealthCheck
{
    private const int MaxQueueDepth = 10_000; // Alert threshold

    public async Task<HealthCheckResult> CheckHealthAsync(
        HealthCheckContext context,
        CancellationToken ct)
    {
        try
        {
            var db = redis.GetDatabase();
            var depth = await db.ListLengthAsync("outbox:pending");

            if (depth > MaxQueueDepth)
            {
                logger.LogWarning(
                    "Message queue depth {Depth} exceeds threshold {Max}",
                    depth, MaxQueueDepth);

                return HealthCheckResult.Degraded(
                    $"Queue depth {depth} exceeds {MaxQueueDepth}",
                    data: new Dictionary<string, object> { ["queueDepth"] = depth });
            }

            return HealthCheckResult.Healthy($"Queue depth: {depth}");
        }
        catch (Exception ex)
        {
            return HealthCheckResult.Unhealthy("Failed to check queue depth", ex);
        }
    }
}

// ✅ Correct: structured health response — machine-readable for monitoring
private static Task WriteHealthResponse(
    HttpContext context,
    HealthReport report)
{
    context.Response.ContentType = "application/json";

    var response = new
    {
        status = report.Status.ToString(),
        duration = report.TotalDuration.TotalMilliseconds,
        checks = report.Entries.ToDictionary(
            e => e.Key,
            e => new
            {
                status = e.Value.Status.ToString(),
                duration = e.Value.Duration.TotalMilliseconds,
                description = e.Value.Description,
                error = e.Value.Exception?.Message,
                data = e.Value.Data
            })
    };

    return context.Response.WriteAsJsonAsync(response);
}

// ✅ Kubernetes probe configuration reference:
// livenessProbe:
//   httpGet:
//     path: /health/live
//     port: 8080
//   initialDelaySeconds: 10   # Wait 10s after container start
//   periodSeconds: 10         # Check every 10s
//   failureThreshold: 3       # Kill after 3 consecutive failures (30s)
//   timeoutSeconds: 5
//
// readinessProbe:
//   httpGet:
//     path: /health/ready
//     port: 8080
//   initialDelaySeconds: 5
//   periodSeconds: 5          # Check every 5s
//   failureThreshold: 2       # Remove from LB after 10s (2 * 5s)
//   timeoutSeconds: 3
//
// startupProbe:
//   httpGet:
//     path: /health/startup
//     port: 8080
//   initialDelaySeconds: 5
//   periodSeconds: 5
//   failureThreshold: 30      # Allow 150s for slow startup (migrations)
//   timeoutSeconds: 10
```

## The Trap

```csharp
// A senior developer correctly separates live/ready/startup probes.
// Kubernetes config uses each correctly. Ships.
// The trap: health checks themselves cause cascading failures under load.

// Scenario: /health/ready executes "SELECT 1" against SQL Server.
// 500 pods checking every 5 seconds = 100 health queries per second to SQL Server.
// During a DB performance incident (slow queries), health checks add 100 req/s
// of additional load — the very moment you need DB capacity free for recovery.
// The health checks worsen the incident they're trying to detect.

// Fix 1: health check timeout shorter than probe timeout
// The health check must complete faster than Kubernetes' timeoutSeconds
// so a slow DB is marked Unhealthy before Kubernetes times out and retries

// Fix 2: use a dedicated health check connection — separate pool, lower priority
builder.Services.AddHealthChecks()
    .AddSqlServer(
        connectionString: ConnectionStringWithLowerPriority, // Separate pool
        healthQuery: "SELECT 1",
        name: "sql-server",
        configure: cmd => cmd.CommandTimeout = 2, // 2-second timeout — fail fast
        tags: ["ready", "db"]);

// Fix 3: cache health check results — don't run the check on every probe request
builder.Services.AddHealthChecks()
    .AddCheck<CachedSqlHealthCheck>("sql-cached", tags: ["ready"]);

public sealed class CachedSqlHealthCheck(
    IConnectionMultiplexer redis,
    SqlConnection sqlConn) : IHealthCheck
{
    private static DateTime _lastChecked = DateTime.MinValue;
    private static HealthCheckResult _lastResult = HealthCheckResult.Healthy();
    private static readonly TimeSpan CacheDuration = TimeSpan.FromSeconds(10);

    public async Task<HealthCheckResult> CheckHealthAsync(
        HealthCheckContext context, CancellationToken ct)
    {
        // ✅ Cache the result — don't hammer DB with health checks
        if (DateTime.UtcNow - _lastChecked < CacheDuration)
            return _lastResult;

        try
        {
            await sqlConn.OpenAsync(ct);
            using var cmd = sqlConn.CreateCommand();
            cmd.CommandText = "SELECT 1";
            cmd.CommandTimeout = 2;
            await cmd.ExecuteScalarAsync(ct);
            await sqlConn.CloseAsync();

            _lastResult = HealthCheckResult.Healthy("SQL Server responsive");
        }
        catch (Exception ex)
        {
            _lastResult = HealthCheckResult.Unhealthy("SQL Server unreachable", ex);
        }
        finally
        {
            _lastChecked = DateTime.UtcNow;
        }

        return _lastResult;
    }
}
```

## The Exception
Simple containerised apps without Kubernetes — small internal tools, single-pod deployments, development services — need only a single `/health` endpoint that returns 200/503. The three-probe separation exists to serve Kubernetes' probe semantics. Without Kubernetes, liveness vs readiness is irrelevant. Implement the full three-tier pattern only in environments where the deployment orchestrator can act on each probe independently.

## Before You Merge
- Are liveness probes (`/health/live`) checking ONLY in-process state — zero external dependency calls?
- Are readiness probes (`/health/ready`) checking SQL Server and Redis with a 2-3 second timeout — not the default 30-second timeout?
- Is the health endpoint on a separate port (`8080`) — not exposed through the same external-facing port as the API?
- Are health check results cached for 10+ seconds — preventing health probes from adding load during an incident?
- Does the Kubernetes pod spec use `startupProbe` with a high `failureThreshold` — allowing 2+ minutes for pods that run migrations on startup?
