# SignalR Scaling
> Verified against: .NET 9 | C# 13 | Microsoft.AspNetCore.SignalR 9.x | StackExchange.Redis 2.x
> Last reviewed: 2026-02-22

## The Law
Configure a backplane (Redis or Azure SignalR Service) before deploying more than one application instance — without it, messages only reach clients connected to the same pod.

## Why This Kills You At Scale
Two app pods. User A connected to Pod 1. User B connected to Pod 2. User A sends a message to User B. Pod 1 calls `Clients.Group("conv:xyz").ReceiveMessage()` — but User B's connection is on Pod 2. Pod 2 never receives the call. User B sees nothing. At 100k concurrent users distributed across 10 pods, roughly 90% of messages are silently dropped. This is the most common real-time production incident after first scale-out.

## The Pattern

```csharp
#nullable enable
using Microsoft.AspNetCore.SignalR;
using StackExchange.Redis;

// ✅ Correct: Redis backplane — messages fan out across all pods
builder.Services.AddSignalR()
    .AddStackExchangeRedis(
        builder.Configuration.GetConnectionString("Redis")!,
        options =>
        {
            options.Configuration.AbortOnConnectFail = false; // Don't crash if Redis is briefly unavailable
            options.Configuration.ConnectRetry = 5;
            options.Configuration.ReconnectRetryPolicy = new ExponentialRetry(5000);
            // Prefix channels to avoid collision with other apps on same Redis
            options.Prefix = "PutZige:SignalR";
        });

// ✅ Correct: Azure SignalR Service — managed scaling, no Redis to operate
// Use this over self-managed Redis for production — handles sticky sessions, reconnects
builder.Services.AddSignalR()
    .AddAzureSignalR(builder.Configuration["Azure:SignalR:ConnectionString"]!);

// ✅ Correct: sticky sessions required when NOT using Azure SignalR Service
// Without sticky sessions, negotiate returns Pod 1 but WebSocket connects to Pod 2
// This is fine if WebSocket negotiation and connection go to different pods —
// but only if the backplane is configured. Without backplane, sticky sessions
// are mandatory to ensure the same pod handles negotiate + connect.

// In nginx (for reference):
// upstream signalr {
//     ip_hash; # Sticky sessions by IP
//     server pod1:5000;
//     server pod2:5000;
// }

// ✅ Correct: IHubContext — send to clients from outside a hub (services, Hangfire jobs)
public sealed class RealTimeNotifier(IHubContext<ChatHub, IChatClient> hubContext) : IRealTimeNotifier
{
    public async Task NotifyMessageAsync(Guid conversationId, MessageDto message)
    {
        // Sends to all clients in group across ALL pods via backplane
        await hubContext.Clients
            .Group($"conv:{conversationId}")
            .ReceiveMessage(message);
    }

    public async Task NotifyUserAsync(Guid userId, ConversationDto conversation)
    {
        // Personal group — user may have multiple connections (mobile + desktop)
        await hubContext.Clients
            .Group($"user:{userId}")
            .ConversationCreated(conversation);
    }

    // ✅ Correct: try/catch — SignalR notification failures should not fail the business operation
    public async Task TryNotifyMessageAsync(Guid conversationId, MessageDto message)
    {
        try
        {
            await hubContext.Clients
                .Group($"conv:{conversationId}")
                .ReceiveMessage(message);
        }
        catch (Exception ex)
        {
            // Log but do not rethrow — message is saved to DB, client will poll or reconnect
            _logger.LogWarning(ex,
                "Failed to send real-time notification for conversation {ConversationId}",
                conversationId);
        }
    }
}

// ✅ Correct: register IRealTimeNotifier in DI
// builder.Services.AddScoped<IRealTimeNotifier, RealTimeNotifier>();

// ❌ Wrong: calling hub clients directly from service without IHubContext
// This is impossible — services cannot access Hub instances
// The hub instance is per-connection and scoped to the connection lifetime

// ❌ Wrong: no backplane in multi-pod deployment
builder.Services.AddSignalR(); // Works for 1 pod only — silent failures at 2+
```

## The Trap

```csharp
// A senior developer correctly adds Redis backplane. Tests pass. Ships.
// The trap: Redis connection failure takes down real-time AND HTTP endpoints.

// When Redis becomes unavailable:
// - SignalR cannot publish messages to the backplane
// - By default, hub method calls THROW — the exception propagates to the hub method
// - If the hub method does not catch it, the WebSocket connection is aborted
// - At scale: Redis hiccup = mass WebSocket disconnects = thundering herd reconnects

// Fix: wrap all IHubContext calls in try/catch (shown above in TryNotifyMessageAsync)
// AND configure Redis to not abort on connect failure (shown above AbortOnConnectFail = false)

// Additionally: health check should distinguish between "SignalR degraded" and "app down"
builder.Services.AddHealthChecks()
    .AddRedis(
        builder.Configuration.GetConnectionString("Redis")!,
        name: "signalr-redis",
        failureStatus: Microsoft.Extensions.Diagnostics.HealthChecks.HealthStatus.Degraded,
        // Degraded — not Unhealthy — so load balancer does not remove pod from rotation
        tags: ["signalr", "redis"]);

// The key insight: real-time notifications are best-effort.
// The source of truth is the database.
// If a notification is lost, the client reconnects and polls — no data is lost.
// Never let SignalR notification failures roll back a DB transaction.
```

## The Exception
Single-instance deployments (development, staging with one pod, small internal tools) do not need a backplane. The backplane adds latency (Redis round-trip) and operational complexity. Do not add it prematurely — but add it before horizontal scaling, and test it with at least 2 instances before production goes multi-pod. The moment you add a second instance without a backplane, you have a silent production bug.

## Before You Merge
- Is a backplane (Redis or Azure SignalR Service) configured for any environment with more than one app instance?
- Are all `IHubContext` notification calls wrapped in try/catch — so Redis failures do not abort business operations?
- Is `AbortOnConnectFail = false` set on the Redis connection — preventing startup failure if Redis is briefly unavailable?
- Is the Redis health check reporting `Degraded` (not `Unhealthy`) — so load balancers keep the pod in rotation during Redis hiccup?
- Is the channel prefix set — preventing SignalR channel collision with other applications sharing the same Redis?
