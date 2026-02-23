# SignalR Best Practices
> Verified against: .NET 9 | C# 13 | Microsoft.AspNetCore.SignalR 9.x
> Last reviewed: 2026-02-22

## The Law
Keep hub methods thin — validate, authorize, and dispatch to a service; never put business logic, DB calls, or heavy computation directly inside hub methods.

## Why This Kills You At Scale
A hub method that queries the DB, sends emails, and updates 5 tables runs on the SignalR thread pool with a live WebSocket connection held open during every await. At 10,000 concurrent connections each triggering a hub method simultaneously, your thread pool exhausts, new connections queue, latency spikes to seconds, and the WebSocket server becomes the bottleneck for your entire system — not the DB, not the API, but the real-time layer that should be stateless and fast.

## The Pattern

```csharp
#nullable enable
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;

// ✅ Correct: strongly-typed hub interface — compile-time safety for client method names
public interface IChatClient
{
    Task ReceiveMessage(MessageDto message);
    Task ConversationCreated(ConversationDto conversation);
    Task UserPresenceChanged(Guid userId, bool isOnline);
    Task MessageRead(Guid messageId, Guid readByUserId);
}

// ✅ Correct: hub is thin — authorize, extract identity, dispatch to service
[Authorize]
public sealed class ChatHub(
    IMessageService messageService,
    IPresenceService presenceService,
    ICurrentUserService currentUser) : Hub<IChatClient>
{
    // ✅ Hub method: validate input, call service, return immediately
    public async Task SendMessage(SendMessageRequest request)
    {
        // Lightweight validation only — business logic lives in service
        if (string.IsNullOrWhiteSpace(request.Content) || request.Content.Length > 4000)
        {
            throw new HubException("Invalid message content");
            // HubException is the ONLY exception type that reaches the client
            // All other exceptions are swallowed and logged server-side
        }

        var userId = currentUser.GetUserId();

        // Service handles DB write + fan-out to other clients
        await messageService.SendAsync(userId, request, Context.ConnectionAborted);
    }

    public async Task MarkAsRead(Guid messageId)
    {
        var userId = currentUser.GetUserId();
        await messageService.MarkAsReadAsync(messageId, userId, Context.ConnectionAborted);
    }

    // ✅ Correct: OnConnectedAsync — register presence, join groups
    public override async Task OnConnectedAsync()
    {
        var userId = currentUser.GetUserId();

        // Join user's personal group — for targeted notifications
        await Groups.AddToGroupAsync(Context.ConnectionId, $"user:{userId}");

        // Join conversation groups the user is a member of
        var conversationIds = await presenceService.GetUserConversationIdsAsync(userId);
        foreach (var convId in conversationIds)
            await Groups.AddToGroupAsync(Context.ConnectionId, $"conv:{convId}");

        await presenceService.SetOnlineAsync(userId, Context.ConnectionId);
        await base.OnConnectedAsync();
    }

    // ✅ Correct: OnDisconnectedAsync — always clean up
    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        var userId = currentUser.GetUserId();
        await presenceService.SetOfflineAsync(userId, Context.ConnectionId);
        await base.OnDisconnectedAsync(exception);
    }
}

// ✅ Correct: hub registration in Program.cs
// builder.Services.AddSignalR(options =>
// {
//     options.EnableDetailedErrors = builder.Environment.IsDevelopment();
//     options.MaximumReceiveMessageSize = 32 * 1024; // 32KB — prevent large payload DoS
//     options.ClientTimeoutInterval = TimeSpan.FromSeconds(60);
//     options.KeepAliveInterval = TimeSpan.FromSeconds(15);
// });
// app.MapHub<ChatHub>("/hubs/chat");

// ❌ Wrong: business logic and DB calls in hub method
public sealed class FatHub(AppDbContext context) : Hub
{
    public async Task SendMessage(string content, Guid conversationId)
    {
        // DB query in hub — holds SignalR thread for duration of query
        var conversation = await context.Conversations
            .Include(c => c.Participants)
            .FirstOrDefaultAsync(c => c.Id == conversationId);

        // Business logic in hub — untestable, not reusable
        if (conversation is null) return;
        var message = new Message { Content = content, ConversationId = conversationId };
        context.Messages.Add(message);
        await context.SaveChangesAsync();

        // Notification logic in hub — duplicated from REST API path
        await Clients.Group(conversationId.ToString()).SendAsync("ReceiveMessage", message);
    }
}
```

## The Trap

```csharp
// A senior developer builds a thin hub that dispatches to services.
// Hub methods return quickly. All looks correct.
// The trap: CurrentUserService fails in background threads spawned from hub context.

public sealed class ChatHub(IMessageService messageService) : Hub<IChatClient>
{
    public async Task SendMessage(SendMessageRequest request)
    {
        // This works — we're on the hub's synchronization context
        await messageService.SendAsync(request, Context.ConnectionAborted);
    }
}

public sealed class MessageService(
    ICurrentUserService currentUser, // Reads from IHttpContextAccessor
    IHubContext<ChatHub, IChatClient> hubContext)
{
    public async Task SendAsync(SendMessageRequest request, CancellationToken ct)
    {
        var userId = currentUser.GetUserId(); // ✅ Works — still within request scope

        var message = new Message { SenderId = userId, Content = request.Content };
        // ... save message

        // BUG: Fire-and-forget task loses the current user context
        _ = Task.Run(async () =>
        {
            // IHttpContextAccessor.HttpContext is null in a thread pool thread
            // currentUser.GetUserId() throws NullReferenceException here
            await hubContext.Clients
                .Group($"conv:{request.ConversationId}")
                .ReceiveMessage(message.ToDto());
        });
    }
}

// Fix: capture all needed values BEFORE spawning the task
public async Task SendAsync(SendMessageRequest request, CancellationToken ct)
{
    var userId = currentUser.GetUserId(); // Capture before Task.Run
    var message = new Message { SenderId = userId, Content = request.Content };

    // Notify synchronously within the request scope — no Task.Run needed
    await hubContext.Clients
        .Group($"conv:{request.ConversationId}")
        .ReceiveMessage(message.ToDto());
}
```

## The Exception
For compute-heavy operations triggered via SignalR (video processing status, large file analysis), use a background queue — accept the request in the hub method, enqueue to a Channel or Hangfire job, return immediately. Notify via `IHubContext<T>` from the background worker when complete. The hub method is still thin; the work is fully decoupled.

## Before You Merge
- Are hub methods free of direct DB calls, business logic, and `AppDbContext` references?
- Is `MaximumReceiveMessageSize` set — preventing clients from sending arbitrarily large payloads?
- Does `OnDisconnectedAsync` clean up all presence and group state — even when `exception` is non-null?
- Are `HubException` the only exception type thrown from hub methods — all others caught and logged?
- Is `EnableDetailedErrors` false in production — preventing stack traces from reaching clients?
