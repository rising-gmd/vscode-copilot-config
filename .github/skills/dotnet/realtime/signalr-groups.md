# SignalR Groups
> Verified against: .NET 9 | C# 13 | Microsoft.AspNetCore.SignalR 9.x
> Last reviewed: 2026-02-22

## The Law
Groups are ephemeral — they exist only in memory (or Redis backplane) and must be rebuilt on every connection; never assume a client is in a group unless you added them in the current `OnConnectedAsync`.

## Why This Kills You At Scale
A pod restarts. All SignalR group memberships for connections on that pod are gone — no persistence, no recovery by default. Users reconnect automatically (Angular's `withAutomaticReconnect`), but their connections are NOT re-added to conversation groups unless `OnConnectedAsync` explicitly does it. Messages sent to those groups reach everyone except users whose pod restarted. At 100k users and regular rolling deployments, this silently breaks message delivery for all users every deploy window.

## The Pattern

```csharp
#nullable enable
using Microsoft.AspNetCore.SignalR;

[Authorize]
public sealed class ChatHub(
    IPresenceService presenceService,
    ICurrentUserService currentUser,
    ILogger<ChatHub> logger) : Hub<IChatClient>
{
    // ✅ Correct: rebuild ALL group memberships on every connect — no assumptions
    public override async Task OnConnectedAsync()
    {
        var userId = currentUser.GetUserId();

        // ✅ Personal group — for user-targeted notifications
        await Groups.AddToGroupAsync(Context.ConnectionId, UserGroup(userId));

        // ✅ Conversation groups — rebuild from DB, not from memory
        var conversationIds = await presenceService.GetUserConversationIdsAsync(userId);
        foreach (var convId in conversationIds)
        {
            await Groups.AddToGroupAsync(Context.ConnectionId, ConversationGroup(convId));
        }

        await presenceService.SetOnlineAsync(userId, Context.ConnectionId);

        logger.LogDebug(
            "User {UserId} connected ({ConnectionId}) — joined {Count} conversation groups",
            userId, Context.ConnectionId, conversationIds.Count);

        await base.OnConnectedAsync();
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        var userId = currentUser.GetUserId();

        // ✅ Groups are cleaned up automatically by SignalR on disconnect
        // No need to call RemoveFromGroupAsync — but DO clean up presence
        await presenceService.SetOfflineAsync(userId, Context.ConnectionId);

        if (exception is not null)
            logger.LogWarning(exception, "User {UserId} disconnected with error", userId);

        await base.OnDisconnectedAsync(exception);
    }

    // ✅ Correct: add to group when user joins a new conversation mid-session
    public async Task JoinConversation(Guid conversationId)
    {
        var userId = currentUser.GetUserId();

        // Authorization — must be a participant
        if (!await presenceService.IsConversationMemberAsync(conversationId, userId))
            throw new HubException("Not a member of this conversation");

        await Groups.AddToGroupAsync(Context.ConnectionId, ConversationGroup(conversationId));
    }

    // ✅ Correct: remove from group when user leaves/deletes a conversation
    public async Task LeaveConversation(Guid conversationId)
    {
        await Groups.RemoveFromGroupAsync(
            Context.ConnectionId,
            ConversationGroup(conversationId));
    }

    // ✅ Consistent group name helpers — one source of truth for group naming
    public static string UserGroup(Guid userId) => $"user:{userId}";
    public static string ConversationGroup(Guid conversationId) => $"conv:{conversationId}";

    // ✅ Correct: sending to groups from hub method (thin — delegates to service)
    public async Task SendMessage(SendMessageRequest request)
    {
        var userId = currentUser.GetUserId();
        // Service handles saving + notification — hub just dispatches
        await _messageService.SendAsync(userId, request, Context.ConnectionAborted);
    }
}

// ✅ Correct: sending to groups from outside hub (services, background jobs)
public sealed class SignalRNotifier(IHubContext<ChatHub, IChatClient> hubContext)
    : IRealTimeNotifier
{
    public async Task NotifyMessageSentAsync(Guid conversationId, MessageDto message, CancellationToken ct)
    {
        // Uses static helper for consistent group names
        await hubContext.Clients
            .Group(ChatHub.ConversationGroup(conversationId))
            .ReceiveMessage(message);
    }

    public async Task NotifyUserAsync(Guid userId, ConversationDto conversation, CancellationToken ct)
    {
        await hubContext.Clients
            .Group(ChatHub.UserGroup(userId))
            .ConversationCreated(conversation);
    }
}

// ❌ Wrong: assuming groups persist — not re-joining on connect
public sealed class BrokenHub : Hub<IChatClient>
{
    public override async Task OnConnectedAsync()
    {
        // Only sets presence — doesn't re-join conversation groups
        // After pod restart or reconnect, user receives no messages
        var userId = _currentUser.GetUserId();
        await _presenceService.SetOnlineAsync(userId, Context.ConnectionId);
        await base.OnConnectedAsync();
    }
}

// ❌ Wrong: inconsistent group name strings — typos cause missed notifications
// "conv:xyz" in hub vs "conversation:xyz" in notifier = different groups
await Groups.AddToGroupAsync(id, "conv:abc");
await hubContext.Clients.Group("conversation:abc").ReceiveMessage(msg); // Never received
```

## The Trap

```csharp
// A senior developer rebuilds groups on every connect correctly.
// Group names are consistent via static helpers. Ships.
// The trap: group membership fan-out cost at scale.

// GetUserConversationIdsAsync runs for EVERY connection.
// User with 500 conversations joins 500 groups on connect.
// 10,000 users reconnecting simultaneously (after a rolling deploy) =
// 10,000 × DB query + 500 × Groups.AddToGroupAsync calls per user.
// The reconnect thundering herd hammers the DB.

// Mitigation 1: cache conversation IDs in Redis per user
// Invalidate cache when user joins/leaves a conversation
public async Task<IReadOnlyList<Guid>> GetUserConversationIdsAsync(Guid userId)
{
    var cached = await _redis.GetDatabase()
        .StringGetAsync($"user-convs:{userId}");

    if (cached.HasValue)
        return JsonSerializer.Deserialize<List<Guid>>(cached!)!;

    var ids = await _userRepo.GetConversationIdsAsync(userId);

    await _redis.GetDatabase().StringSetAsync(
        $"user-convs:{userId}",
        JsonSerializer.Serialize(ids),
        TimeSpan.FromMinutes(15));

    return ids;
}

// Mitigation 2: cap group membership — users in > 500 conversations
// use the personal user group only, and fetch conversation membership on message receipt
// Trade-off: slight latency on message display vs connection cost

// Mitigation 3: stagger reconnects — Angular's withAutomaticReconnect
// uses exponential backoff which naturally staggers reconnect storms
```

## The Exception
If using Azure SignalR Service instead of self-hosted SignalR, group membership IS persisted by the service across reconnections — you do not need to rebuild groups in `OnConnectedAsync` unless the user's conversation membership has changed while they were disconnected. However, rebuilding groups defensively on every connect is cheap and correct even with Azure SignalR Service — consistency over cleverness.

## Before You Merge
- Does `OnConnectedAsync` rebuild ALL group memberships from the database — not assume prior state?
- Are group name strings defined as static methods or constants in one place — never hardcoded strings scattered across files?
- Does `OnDisconnectedAsync` clean up presence but NOT call `RemoveFromGroupAsync` — SignalR handles group cleanup automatically on disconnect?
- Does `JoinConversation` authorize the user is a member before adding to the group?
- Is the `GetUserConversationIdsAsync` call in `OnConnectedAsync` protected by a cache — to handle reconnect thundering herds?
