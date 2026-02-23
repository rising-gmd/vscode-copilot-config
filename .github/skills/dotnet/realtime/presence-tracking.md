# Presence Tracking
> Verified against: .NET 9 | C# 13 | Microsoft.AspNetCore.SignalR 9.x | StackExchange.Redis 2.x
> Last reviewed: 2026-02-22

## The Law
Track presence per connection ID, not per user ID — a user can have multiple concurrent connections (mobile + desktop + browser tab) and presence is only truly offline when all connections are gone.

## Why This Kills You At Scale
A user opens the app on their phone and laptop simultaneously. Phone disconnects. Your presence service sets `IsOnline = false` for the user ID. Laptop is still connected — the user is visibly online but shown as offline to all contacts. At 100k users, a significant portion use multiple devices. Incorrect presence destroys trust in the real-time feature and cannot be diagnosed from logs — it looks like a bug that "randomly" goes away.

## The Pattern

```csharp
#nullable enable
using StackExchange.Redis;

// ✅ Correct: Redis-backed presence — tracks all connection IDs per user
public sealed class PresenceService(
    IConnectionMultiplexer redis,
    IHubContext<ChatHub, IChatClient> hubContext,
    IUserRepository userRepo,
    IUnitOfWork unitOfWork,
    ILogger<PresenceService> logger) : IPresenceService
{
    // Redis key: "presence:userId" → Set of connectionIds
    private static string PresenceKey(Guid userId) => $"presence:{userId}";

    // ✅ Correct: add connection to user's set, notify if this is FIRST connection
    public async Task SetOnlineAsync(Guid userId, string connectionId)
    {
        var db = redis.GetDatabase();
        var key = PresenceKey(userId);

        var wasOffline = await db.SetLengthAsync(key) == 0;

        // Add this connection to user's set, with expiry as safety net
        // Expiry ensures stale connections don't keep user "online" after server crash
        await db.SetAddAsync(key, connectionId);
        await db.KeyExpireAsync(key, TimeSpan.FromHours(24)); // Safety net expiry

        if (wasOffline)
        {
            // First connection — user came online
            await UpdateDbPresenceAsync(userId, isOnline: true);
            await BroadcastPresenceChangeAsync(userId, isOnline: true);
        }
    }

    // ✅ Correct: remove connection, notify only if LAST connection gone
    public async Task SetOfflineAsync(Guid userId, string connectionId)
    {
        var db = redis.GetDatabase();
        var key = PresenceKey(userId);

        await db.SetRemoveAsync(key, connectionId);
        var remainingConnections = await db.SetLengthAsync(key);

        if (remainingConnections == 0)
        {
            // Last connection gone — user truly offline
            await UpdateDbPresenceAsync(userId, isOnline: false);
            await BroadcastPresenceChangeAsync(userId, isOnline: false);
        }
    }

    public async Task<bool> IsOnlineAsync(Guid userId)
    {
        var db = redis.GetDatabase();
        return await db.SetLengthAsync(PresenceKey(userId)) > 0;
    }

    public async Task<IReadOnlyList<Guid>> GetOnlineUsersAsync(IEnumerable<Guid> userIds)
    {
        var db = redis.GetDatabase();
        var tasks = userIds.Select(async id => new
        {
            UserId = id,
            IsOnline = await db.SetLengthAsync(PresenceKey(id)) > 0
        });
        var results = await Task.WhenAll(tasks);
        return results.Where(r => r.IsOnline).Select(r => r.UserId).ToList();
    }

    // ✅ Get conversation IDs for group join on connect
    public async Task<IReadOnlyList<Guid>> GetUserConversationIdsAsync(Guid userId)
        => await userRepo.GetConversationIdsAsync(userId);

    private async Task UpdateDbPresenceAsync(Guid userId, bool isOnline)
    {
        try
        {
            await userRepo.UpdatePresenceAsync(userId, isOnline, DateTime.UtcNow);
            await unitOfWork.SaveChangesAsync();
        }
        catch (Exception ex)
        {
            // Non-fatal — Redis is source of truth for real-time, DB is for last seen
            logger.LogWarning(ex, "Failed to update DB presence for user {UserId}", userId);
        }
    }

    private async Task BroadcastPresenceChangeAsync(Guid userId, bool isOnline)
    {
        try
        {
            // Broadcast to all users who are contacts — they need to update their UI
            var contactIds = await userRepo.GetContactIdsAsync(userId);
            foreach (var contactId in contactIds)
            {
                await hubContext.Clients
                    .Group($"user:{contactId}")
                    .UserPresenceChanged(userId, isOnline);
            }
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Failed to broadcast presence change for user {UserId}", userId);
        }
    }
}

// ❌ Wrong: track by userId — breaks multi-device
public class SingleDevicePresence
{
    public async Task SetOnlineAsync(Guid userId, string connectionId)
    {
        // Overwrites — second device connection makes first's disconnect look like offline
        await _db.StringSetAsync($"presence:{userId}", "online");
    }

    public async Task SetOfflineAsync(Guid userId, string connectionId)
    {
        // Phone disconnects — sets offline even though laptop is still connected
        await _db.KeyDeleteAsync($"presence:{userId}");
    }
}
```

## The Trap

```csharp
// A senior developer correctly tracks per-connection presence.
// Works on multiple devices. Ships.
// The trap: server crash or pod restart leaves stale connection IDs in Redis.

// Scenario: pod crashes without calling OnDisconnectedAsync.
// The Redis set for the user still contains the dead connectionId.
// User's set has length > 0 — they appear online forever.
// User can't "come online" again because SetOnlineAsync sees wasOffline = false.

// The 24-hour key expiry is a partial mitigation — but there's a better fix.

// Fix: on pod startup, clear any connection IDs that belong to THIS pod's previous instance.
// Connection IDs are pod-specific — use a pod ID prefix.

public sealed class PresenceStartupService(
    IConnectionMultiplexer redis,
    IHostApplicationLifetime lifetime) : IHostedService
{
    // Pod ID is stable for the pod's lifetime — changes on restart
    private static readonly string PodId = Environment.GetEnvironmentVariable("POD_NAME")
        ?? Environment.MachineName;

    public async Task StartAsync(CancellationToken ct)
    {
        // Scan for all presence keys containing this pod's old connection IDs
        // Connection IDs are generated by SignalR and contain no pod info by default
        // So prefix them on SetOnlineAsync: $"{PodId}:{connectionId}"
        // Then on startup, scan and remove all keys with this pod's prefix
        var db = redis.GetDatabase();
        var server = redis.GetServer(redis.GetEndPoints().First());

        // Remove stale connections from this pod's previous instance
        await foreach (var key in server.KeysAsync(pattern: "presence:*"))
        {
            var staleMembers = await db.SetMembersAsync(key);
            var staleFromThisPod = staleMembers
                .Where(m => m.ToString().StartsWith(PodId))
                .ToArray();

            if (staleFromThisPod.Length > 0)
                await db.SetRemoveAsync(key, staleFromThisPod);
        }
    }

    public Task StopAsync(CancellationToken ct) => Task.CompletedTask;
}
```

## The Exception
For internal tools or low-traffic apps (< 1,000 concurrent users, single device per user assumed), tracking presence in the SQL Server `UserSessions` table with `IsOnline` and `LastActiveAt` columns is sufficient — no Redis needed. Redis presence becomes necessary when: (1) multiple devices per user are supported, (2) real-time accuracy of presence matters, or (3) presence queries for large contact lists would hammer the DB.

## Before You Merge
- Is presence tracked per connection ID — not per user ID — so multi-device users show correctly?
- Does `SetOfflineAsync` check remaining connection count before broadcasting offline status?
- Is there a Redis key expiry set as a safety net for crashed pods that skip `OnDisconnectedAsync`?
- Does `OnDisconnectedAsync` call `SetOfflineAsync` even when `exception` is non-null?
- Is presence broadcast wrapped in try/catch — so a failed notification does not abort the disconnect cleanup?
