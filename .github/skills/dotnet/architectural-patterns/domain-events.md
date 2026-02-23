# Domain Events
> Verified against: .NET 9 | C# 13 | MediatR 12.x | EF Core 9.x
> Last reviewed: 2026-02-22

## The Law
Raise domain events inside the aggregate, dispatch them after `SaveChanges` succeeds — never dispatch events before the transaction commits or from inside a repository.

## Why This Kills You At Scale
A domain event dispatched before `SaveChanges` triggers a side effect — sending an email, publishing to a queue, notifying via SignalR. The `SaveChanges` subsequently fails and rolls back. The email was already sent. The queue message was already published. The user receives a notification for a message that does not exist in the database. At 100k messages/day with a 0.01% transient DB failure rate, that is 10 phantom notifications per day — each one a support ticket.

## The Pattern

```csharp
#nullable enable
using MediatR;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;

// ✅ Correct: domain event base — lives in Domain layer, no framework imports
public abstract record DomainEvent
{
    public Guid EventId { get; } = Guid.NewGuid();
    public DateTime OccurredAt { get; } = DateTime.UtcNow;
}

// ✅ Correct: specific domain events — named past tense (something happened)
public sealed record MessageSentEvent(
    Guid MessageId,
    Guid ConversationId,
    Guid SenderId,
    string Content,
    DateTime SentAt) : DomainEvent;

public sealed record ConversationCreatedEvent(
    Guid ConversationId,
    Guid CreatedByUserId,
    IReadOnlyList<Guid> ParticipantIds) : DomainEvent;

// ✅ Correct: aggregate base — collects domain events internally
public abstract class AggregateRoot
{
    private readonly List<DomainEvent> _domainEvents = [];

    public IReadOnlyList<DomainEvent> DomainEvents => _domainEvents.AsReadOnly();

    protected void RaiseDomainEvent(DomainEvent domainEvent)
        => _domainEvents.Add(domainEvent);

    public void ClearDomainEvents() => _domainEvents.Clear();
}

// ✅ Correct: entity raises its own event — domain logic is cohesive
public sealed class Message : AggregateRoot
{
    public Guid Id { get; private set; }
    public Guid ConversationId { get; private set; }
    public Guid SenderId { get; private set; }
    public string Content { get; private set; } = string.Empty;
    public DateTime SentAt { get; private set; }

    public static Message Create(Guid conversationId, Guid senderId, string content)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(content);
        if (content.Length > 4000)
            throw new DomainException("Message too long");

        var message = new Message
        {
            Id = Guid.NewGuid(),
            ConversationId = conversationId,
            SenderId = senderId,
            Content = content.Trim(),
            SentAt = DateTime.UtcNow
        };

        // ✅ Event raised inside entity — event has all needed data
        message.RaiseDomainEvent(new MessageSentEvent(
            message.Id,
            message.ConversationId,
            message.SenderId,
            message.Content,
            message.SentAt));

        return message;
    }
}

// ✅ Correct: EF Core SaveChanges interceptor — dispatch AFTER commit
public sealed class DomainEventDispatchInterceptor(IMediator mediator)
    : SaveChangesInterceptor
{
    public override async ValueTask<int> SavedChangesAsync(
        SaveChangesCompletedEventData eventData,
        int result,
        CancellationToken ct = default)
    {
        // ✅ SavedChangesAsync fires AFTER the transaction commits
        // Events dispatched here are guaranteed the DB write succeeded
        var aggregates = eventData.Context!.ChangeTracker
            .Entries<AggregateRoot>()
            .Where(e => e.Entity.DomainEvents.Count > 0)
            .Select(e => e.Entity)
            .ToList();

        var events = aggregates
            .SelectMany(a => a.DomainEvents)
            .OrderBy(e => e.OccurredAt)
            .ToList();

        foreach (var aggregate in aggregates)
            aggregate.ClearDomainEvents();

        // Dispatch all events — handlers run after commit
        foreach (var domainEvent in events)
            await mediator.Publish(domainEvent, ct);

        return result;
    }
}

// ✅ Correct: domain event handler — reacts to what happened
public sealed class MessageSentEventHandler(
    IRealTimeNotifier notifier,
    IEmailService emailService,
    ILogger<MessageSentEventHandler> logger)
    : INotificationHandler<MessageSentEvent>
{
    public async Task Handle(MessageSentEvent notification, CancellationToken ct)
    {
        // ✅ Side effects here — safe because DB already committed
        var dto = new MessageDto(
            notification.MessageId,
            notification.Content,
            notification.SenderId,
            notification.SentAt);

        await notifier.NotifyMessageSentAsync(notification.ConversationId, dto, ct);

        // Email notification for offline recipients — safe to send now
        await emailService.SendMessageNotificationAsync(
            notification.ConversationId,
            notification.SenderId,
            ct);
    }
}

// ✅ Correct: register interceptor in DI
// builder.Services.AddScoped<DomainEventDispatchInterceptor>();
// builder.Services.AddDbContext<AppDbContext>((sp, options) =>
// {
//     options.AddInterceptors(sp.GetRequiredService<DomainEventDispatchInterceptor>());
// });

// ❌ Wrong: dispatching events before SaveChanges
public sealed class BrokenMessageService(IMediator mediator, IUnitOfWork unitOfWork)
{
    public async Task SendAsync(Message message, CancellationToken ct)
    {
        await _messageRepo.AddAsync(message, ct);

        // BUG: events dispatched before SaveChanges
        // If SaveChanges fails, side effects already happened
        foreach (var domainEvent in message.DomainEvents)
            await mediator.Publish(domainEvent, ct);

        await unitOfWork.SaveChangesAsync(ct); // Too late to undo side effects if this throws
    }
}
```

## The Trap

```csharp
// A senior developer correctly dispatches events after SaveChanges via interceptor.
// Events fire after commit. Side effects are safe. Ships.
// The trap: MediatR's Publish() throws if any handler throws.
// One failing handler (e.g., email service down) rolls back... nothing.
// DB is already committed. But the exception bubbles up from SaveChangesAsync.
// The calling service sees an exception and may retry — creating duplicate DB entries
// if the operation is not idempotent.

// Fix 1: catch exceptions in individual handlers — isolate handler failures
public sealed class MessageSentEventHandler(IRealTimeNotifier notifier, ILogger<MessageSentEventHandler> logger)
    : INotificationHandler<MessageSentEvent>
{
    public async Task Handle(MessageSentEvent notification, CancellationToken ct)
    {
        try
        {
            await notifier.NotifyMessageSentAsync(notification.ConversationId,
                new MessageDto(notification.MessageId, notification.Content,
                    notification.SenderId, notification.SentAt), ct);
        }
        catch (Exception ex)
        {
            // Log but do not rethrow — DB is committed, notification is best-effort
            logger.LogWarning(ex, "Failed to send real-time notification for message {MessageId}",
                notification.MessageId);
        }
    }
}

// Fix 2: for critical side effects that must not be lost on failure,
// use the Outbox Pattern (separate skill) instead of in-process domain events.
// Outbox guarantees at-least-once delivery even if the handler crashes.
```

## The Exception
For synchronous domain events that must run within the same transaction — e.g., updating a denormalized `LastActivity` field on a parent entity when a child is created — use a synchronous in-transaction approach via `SavingChanges` (not `SavedChanges`). These are not true domain events; they are domain invariants enforced within the transaction boundary. Name them clearly as invariants, not events, to distinguish them from post-commit side effects.

## Before You Merge
- Are domain events dispatched in `SavedChangesAsync` (after commit) — never in `SavingChangesAsync` (before commit)?
- Does each domain event handler catch its own exceptions — preventing one failing handler from surfacing as a business logic error?
- Are domain events cleared from the aggregate after dispatch — preventing double-dispatch on the next `SaveChanges` call?
- Are events ordered by `OccurredAt` before dispatch — ensuring causal ordering within a single transaction?
- Are side effects that must not be lost (emails, payment processing) using the Outbox Pattern — not in-process domain events?
