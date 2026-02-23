# Real-Time Notifier Pattern
> Verified against: .NET 9 | C# 13 | Microsoft.AspNetCore.SignalR 9.x
> Last reviewed: 2026-02-22

## The Law
Define `IRealTimeNotifier` in the Application layer and implement it in Infrastructure — Application layer services must never reference `IHubContext<T>` or any SignalR type directly.

## Why This Kills You At Scale
An application service that imports `Microsoft.AspNetCore.SignalR` is untestable without a running SignalR server, cannot be moved to a worker service without pulling in ASP.NET Core dependencies, and couples your business logic to a specific transport mechanism. At 100k users, when you need to swap SignalR for Azure SignalR Service or add a parallel WebSocket implementation, you rewrite every service that imported `IHubContext<T>` instead of changing one class.

## The Pattern

```csharp
#nullable enable
using Microsoft.AspNetCore.SignalR;

// ✅ Correct: interface defined in Application layer — zero SignalR imports
// Application/Interfaces/IRealTimeNotifier.cs
public interface IRealTimeNotifier
{
    // Methods named by business event — not by transport mechanism
    Task NotifyMessageSentAsync(Guid conversationId, MessageDto message, CancellationToken ct = default);
    Task NotifyConversationCreatedAsync(Guid userId, ConversationDto conversation, CancellationToken ct = default);
    Task NotifyMessageReadAsync(Guid conversationId, Guid messageId, Guid readByUserId, CancellationToken ct = default);
    Task NotifyUserPresenceChangedAsync(Guid userId, bool isOnline, CancellationToken ct = default);
}

// ✅ Correct: implementation in Infrastructure layer — SignalR lives here only
// Infrastructure/SignalR/SignalRNotifier.cs
public sealed class SignalRNotifier(
    IHubContext<ChatHub, IChatClient> hubContext,
    ILogger<SignalRNotifier> logger) : IRealTimeNotifier
{
    public async Task NotifyMessageSentAsync(
        Guid conversationId, MessageDto message, CancellationToken ct = default)
    {
        try
        {
            await hubContext.Clients
                .Group($"conv:{conversationId}")
                .ReceiveMessage(message);
        }
        catch (Exception ex)
        {
            // Notification failure must never propagate to business logic
            // Message is already saved to DB — client will get it on reconnect
            logger.LogWarning(ex,
                "Real-time notification failed for conversation {ConversationId}", conversationId);
        }
    }

    public async Task NotifyConversationCreatedAsync(
        Guid userId, ConversationDto conversation, CancellationToken ct = default)
    {
        try
        {
            await hubContext.Clients
                .Group($"user:{userId}")
                .ConversationCreated(conversation);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex,
                "Failed to notify user {UserId} of new conversation", userId);
        }
    }

    public async Task NotifyMessageReadAsync(
        Guid conversationId, Guid messageId, Guid readByUserId, CancellationToken ct = default)
    {
        try
        {
            await hubContext.Clients
                .Group($"conv:{conversationId}")
                .MessageRead(messageId, readByUserId);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Failed to notify message read {MessageId}", messageId);
        }
    }

    public async Task NotifyUserPresenceChangedAsync(
        Guid userId, bool isOnline, CancellationToken ct = default)
    {
        try
        {
            // Notify contacts — not implemented here, delegated to PresenceService
            // This method exists for completeness and testability
            await hubContext.Clients
                .Group($"presence-watchers:{userId}")
                .UserPresenceChanged(userId, isOnline);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Failed to broadcast presence for user {UserId}", userId);
        }
    }
}

// ✅ Correct: NoOp implementation — for unit tests and worker services
// This is the key testability win — swap in NoOp, test business logic without SignalR
public sealed class NoOpRealTimeNotifier : IRealTimeNotifier
{
    public Task NotifyMessageSentAsync(Guid conversationId, MessageDto message, CancellationToken ct = default)
        => Task.CompletedTask;

    public Task NotifyConversationCreatedAsync(Guid userId, ConversationDto conversation, CancellationToken ct = default)
        => Task.CompletedTask;

    public Task NotifyMessageReadAsync(Guid conversationId, Guid messageId, Guid readByUserId, CancellationToken ct = default)
        => Task.CompletedTask;

    public Task NotifyUserPresenceChangedAsync(Guid userId, bool isOnline, CancellationToken ct = default)
        => Task.CompletedTask;
}

// ✅ Correct: DI registration
// builder.Services.AddScoped<IRealTimeNotifier, SignalRNotifier>();

// ✅ Correct: Application service — no SignalR knowledge whatsoever
public sealed class MessageService(
    IMessageRepository messageRepo,
    IConversationRepository conversationRepo,
    IUnitOfWork unitOfWork,
    IRealTimeNotifier notifier, // Only this — not IHubContext<T>
    ICurrentUserService currentUser)
{
    public async Task<MessageDto> SendAsync(SendMessageRequest request, CancellationToken ct)
    {
        var userId = currentUser.GetUserId();

        var message = new Message
        {
            Id = Guid.NewGuid(),
            ConversationId = request.ConversationId,
            SenderId = userId,
            Content = request.Content,
            SentAt = DateTime.UtcNow
        };

        await messageRepo.AddAsync(message, ct);
        await unitOfWork.SaveChangesAsync(ct);

        var dto = message.ToDto();

        // Notify AFTER commit — fire and forget, never block business operation
        await notifier.NotifyMessageSentAsync(request.ConversationId, dto, ct);

        return dto;
    }
}

// ❌ Wrong: IHubContext directly in application service
public sealed class BadMessageService(
    IHubContext<ChatHub, IChatClient> hubContext) // SignalR in Application layer
{
    // Now this service cannot be tested without SignalR
    // Cannot be moved to a Hangfire worker without ASP.NET Core
    // Cannot be swapped to a different transport without rewriting this class
}
```

## The Trap

```csharp
// A senior developer correctly uses IRealTimeNotifier with NoOp for tests.
// Unit tests are fast and pass. Integration tests pass. Ships.
// The trap: notification is called before SaveChanges in a subtle way.

public sealed class ConversationService(
    IConversationRepository repo,
    IUnitOfWork unitOfWork,
    IRealTimeNotifier notifier)
{
    public async Task<ConversationDto> CreateAsync(Guid userId, Guid otherUserId, CancellationToken ct)
    {
        var conversation = new Conversation { /* ... */ };
        await repo.AddAsync(conversation, ct);

        var dto = conversation.ToDto();

        // BUG: Notification sent BEFORE SaveChanges
        // Other user receives "ConversationCreated" event, navigates to the conversation,
        // their client makes GET /api/conversations/{id} — but SaveChanges hasn't run yet.
        // DB returns 404. Client shows an error. Race condition in production.
        await notifier.NotifyConversationCreatedAsync(otherUserId, dto, ct);

        await unitOfWork.SaveChangesAsync(ct); // Too late
        return dto;
    }
}

// Fix: always SaveChanges THEN notify
public async Task<ConversationDto> CreateFixedAsync(Guid userId, Guid otherUserId, CancellationToken ct)
{
    var conversation = new Conversation { /* ... */ };
    await repo.AddAsync(conversation, ct);

    // 1. Persist first — source of truth is the DB
    await unitOfWork.SaveChangesAsync(ct);

    var dto = conversation.ToDto();

    // 2. Notify after — client can now successfully fetch the resource
    await notifier.NotifyConversationCreatedAsync(otherUserId, dto, ct);

    return dto;
}
```

## The Exception
If your application is a pure background worker service with no HTTP or SignalR endpoints, substitute the `SignalRNotifier` with an implementation that publishes to Azure Service Bus or a message queue — the interface stays identical. The Application layer is completely unaware of this swap. This is the architectural value of the abstraction.

## Before You Merge
- Is `IRealTimeNotifier` defined in the Application layer with zero SignalR or ASP.NET Core imports?
- Does `SignalRNotifier` catch all exceptions and log warnings — never propagating to business logic?
- Is `NoOpRealTimeNotifier` registered in test projects — so unit tests run without SignalR?
- Does every `Notify*` call happen after `SaveChangesAsync` — not before?
- Are notification method names describing business events — not transport operations (`NotifyMessageSentAsync` not `SendToGroupAsync`)?
