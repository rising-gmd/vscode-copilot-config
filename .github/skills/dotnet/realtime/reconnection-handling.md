# Reconnection Handling
> Verified against: .NET 9 | C# 13 | Microsoft.AspNetCore.SignalR 9.x
> Last reviewed: 2026-02-22

## The Law
Design for reconnection as the normal case — persist all state to the database before notifying via SignalR, and provide a REST API fallback so clients can recover missed messages after any disconnection.

## Why This Kills You At Scale
A user's mobile network drops for 30 seconds. SignalR reconnects. During those 30 seconds, 15 messages were sent to their conversations. The SignalR client reconnects and resumes — but missed messages are never delivered because your server only pushes messages at the moment of sending and has no replay mechanism. At 100k users on mobile networks with real-world connectivity, this is not edge case — this is constant. Your chat app silently loses messages for every mobile user.

## The Pattern

```csharp
#nullable enable
using Microsoft.AspNetCore.SignalR;

// ✅ Correct: server-side — state is in DB, SignalR is just the delivery mechanism
public sealed class MessageService(
    IMessageRepository messageRepo,
    IUnitOfWork unitOfWork,
    IRealTimeNotifier notifier)
{
    public async Task<MessageDto> SendAsync(SendMessageRequest request, CancellationToken ct)
    {
        // 1. Persist FIRST — message exists regardless of client connection state
        var message = new Message
        {
            Id = Guid.NewGuid(),
            Content = request.Content,
            ConversationId = request.ConversationId,
            SentAt = DateTime.UtcNow,
            SenderId = request.SenderId
        };
        await messageRepo.AddAsync(message, ct);
        await unitOfWork.SaveChangesAsync(ct);

        // 2. Notify — best effort, client recovers via REST if this fails
        await notifier.NotifyMessageSentAsync(request.ConversationId, message.ToDto(), ct);

        return message.ToDto();
    }
}

// ✅ Correct: REST endpoint for missed message recovery
// Client calls this after reconnect with their last-known message timestamp
[HttpGet("conversations/{conversationId}/messages/since")]
[Authorize]
public async Task<IActionResult> GetMessagesSince(
    Guid conversationId,
    [FromQuery] DateTime since, // Client sends their last-received message timestamp
    CancellationToken ct)
{
    var userId = _currentUser.GetUserId();

    // Authorization check — user must be member
    if (!await _conversationRepo.IsUserMemberAsync(conversationId, userId, ct))
        return NotFound();

    // Return all messages since the client's last known state
    var messages = await _messageRepo.GetSinceAsync(conversationId, since, ct);
    return Ok(messages);
}

// ✅ Correct: hub — track reconnection state and trigger recovery
[Authorize]
public sealed class ChatHub(
    IPresenceService presenceService,
    IMessageRepository messageRepo,
    ICurrentUserService currentUser) : Hub<IChatClient>
{
    public override async Task OnConnectedAsync()
    {
        var userId = currentUser.GetUserId();

        // Re-join all groups (groups are not persisted across connections)
        var conversationIds = await presenceService.GetUserConversationIdsAsync(userId);
        foreach (var convId in conversationIds)
            await Groups.AddToGroupAsync(Context.ConnectionId, $"conv:{convId}");

        await Groups.AddToGroupAsync(Context.ConnectionId, $"user:{userId}");
        await presenceService.SetOnlineAsync(userId, Context.ConnectionId);

        await base.OnConnectedAsync();
    }

    // ✅ Hub method: client calls this after reconnect to get missed messages
    public async Task SyncMissedMessages(DateTime lastSyncTime)
    {
        var userId = currentUser.GetUserId();
        var conversationIds = await presenceService.GetUserConversationIdsAsync(userId);

        foreach (var convId in conversationIds)
        {
            var missed = await messageRepo.GetSinceAsync(convId, lastSyncTime,
                Context.ConnectionAborted);

            if (missed.Count > 0)
            {
                // Send missed messages directly to this connection only
                foreach (var msg in missed)
                    await Clients.Caller.ReceiveMessage(msg.ToDto());
            }
        }
    }
}

// ✅ Correct: Angular reconnection strategy (TypeScript for reference)
// const connection = new HubConnectionBuilder()
//     .withUrl('/hubs/chat', { withCredentials: true })
//     .withAutomaticReconnect({
//         nextRetryDelayInMilliseconds: (retryContext) => {
//             // Exponential backoff: 0, 2s, 10s, 30s, then null (stop)
//             const delays = [0, 2000, 10000, 30000];
//             return delays[retryContext.previousRetryCount] ?? null;
//         }
//     })
//     .build();
//
// connection.onreconnected(async (connectionId) => {
//     const lastSync = localStorage.getItem('lastSyncTime') ?? new Date(0).toISOString();
//     await connection.invoke('SyncMissedMessages', lastSync);
//     localStorage.setItem('lastSyncTime', new Date().toISOString());
// });

// ❌ Wrong: relying on SignalR delivery as the only delivery mechanism
public async Task SendMessageWrong(string content, Guid conversationId)
{
    // Message only sent via SignalR — if any client is disconnected, they miss it forever
    // No DB persistence first
    await Clients.Group($"conv:{conversationId}").SendAsync("ReceiveMessage", content);
}
```

## The Trap

```csharp
// A senior developer implements DB-first + REST recovery correctly.
// Works perfectly. Ships.
// The trap: SyncMissedMessages called with wrong lastSyncTime — gaps or duplicates.

// Scenario: client stores lastSyncTime = T1 in memory.
// Client disconnects at T1.
// Reconnects at T2.
// Calls SyncMissedMessages(T1) — correct.
// BUT: client's clock is 30 seconds behind server's clock.
// T1 (client) < T1 (server) by 30 seconds.
// Messages sent in that 30-second window: not in client's range.
// Client silently misses 30 seconds of messages on every reconnect.

// Fix: use server-generated monotonic sequence IDs — not timestamps — for sync.
// Store last-received message ID, not timestamp.

public async Task SyncMissedMessages(long lastMessageSequenceId)
{
    var userId = currentUser.GetUserId();
    var conversationIds = await presenceService.GetUserConversationIdsAsync(userId);

    foreach (var convId in conversationIds)
    {
        // SequenceId is a DB-generated IDENTITY column — monotonic, no clock drift
        var missed = await messageRepo.GetAfterSequenceAsync(convId, lastMessageSequenceId,
            Context.ConnectionAborted);

        foreach (var msg in missed)
            await Clients.Caller.ReceiveMessage(msg.ToDto());
    }
}

// Message table: add SequenceId BIGINT IDENTITY(1,1) column
// Client tracks: lastReceivedSequenceId per conversation
// No clock drift. No duplicates. No gaps.
```

## The Exception
Internal real-time dashboards showing live metrics (server CPU, active user count, queue depth) have ephemeral data that is meaningless 30 seconds after it was generated — missed values during disconnection are irrelevant. These do not need recovery mechanisms. The recovery pattern applies to user-generated content where missing data means lost business value.

## Before You Merge
- Is every message persisted to the DB before the SignalR notification is sent?
- Is there a REST endpoint for clients to recover missed messages by sequence ID or timestamp?
- Does `OnConnectedAsync` re-join all conversation groups — since groups are not persisted across connections?
- Does the `SyncMissedMessages` hub method use a sequence ID — not a client timestamp — to avoid clock drift gaps?
- Does the Angular client call `SyncMissedMessages` in the `onreconnected` callback — not `onconnected`?
