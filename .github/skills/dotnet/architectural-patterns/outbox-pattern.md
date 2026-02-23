# Outbox Pattern
> Verified against: .NET 9 | C# 13 | EF Core 9.x | Hangfire 1.8.x | MassTransit 8.x
> Last reviewed: 2026-02-22

## The Law
Write domain events to an outbox table in the same DB transaction as the business operation — never publish to a message broker or trigger side effects (email, SignalR, external API) inside a DB transaction.

## Why This Kills You At Scale
A user sends a message. Your code saves the message to DB, then calls SignalR to notify recipients. The SignalR call fails. The message is saved but recipients never see it. Or: the DB save succeeds, the email service is called, the email is sent — then the DB transaction is rolled back due to a concurrency conflict. The email was sent for a transaction that didn't commit. At 100k users, these split-brain failures accumulate into a persistent user-trust problem that is impossible to diagnose from logs.

## The Pattern

```csharp
#nullable enable
using Microsoft.EntityFrameworkCore;

// ✅ Correct: outbox message entity stored in same DB
public sealed class OutboxMessage
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public string Type { get; set; } = string.Empty;      // Event type name
    public string Payload { get; set; } = string.Empty;   // JSON-serialized event
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? ProcessedAt { get; set; }            // null = not yet processed
    public string? Error { get; set; }                    // Last processing error
    public int RetryCount { get; set; }
}

// ✅ Correct: in DbContext
public DbSet<OutboxMessage> OutboxMessages => Set<OutboxMessage>();

// ✅ Correct: domain event
public sealed record MessageSentEvent(
    Guid MessageId,
    Guid ConversationId,
    Guid SenderId,
    string Content,
    DateTime SentAt);

// ✅ Correct: service writes to outbox atomically with the business operation
public sealed class MessageService(
    AppDbContext context,
    IUnitOfWork unitOfWork)
{
    public async Task<MessageDto> SendAsync(
        SendMessageRequest request, CancellationToken ct)
    {
        var message = new Message
        {
            Id = Guid.NewGuid(),
            ConversationId = request.ConversationId,
            SenderId = request.SenderId,
            Content = request.Content,
            SentAt = DateTime.UtcNow
        };

        context.Messages.Add(message);

        // ✅ Write event to outbox — SAME transaction as the message insert
        var outboxMessage = new OutboxMessage
        {
            Type = nameof(MessageSentEvent),
            Payload = System.Text.Json.JsonSerializer.Serialize(
                new MessageSentEvent(message.Id, message.ConversationId,
                    message.SenderId, message.Content, message.SentAt))
        };

        context.OutboxMessages.Add(outboxMessage);

        // Both message and outbox entry committed atomically — or both rolled back
        await unitOfWork.SaveChangesAsync(ct);

        return message.ToDto();
    }
}

// ✅ Correct: background processor reads outbox and dispatches events
public sealed class OutboxProcessor(
    AppDbContext context,
    ISignalRNotifier signalRNotifier,
    IEmailService emailService,
    ILogger<OutboxProcessor> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            await ProcessBatchAsync(stoppingToken);
            await Task.Delay(TimeSpan.FromSeconds(5), stoppingToken);
        }
    }

    private async Task ProcessBatchAsync(CancellationToken ct)
    {
        // ✅ Select unprocessed messages — with retry limit
        var messages = await context.OutboxMessages
            .Where(m => m.ProcessedAt == null && m.RetryCount < 5)
            .OrderBy(m => m.CreatedAt)
            .Take(50)
            .ToListAsync(ct);

        foreach (var outboxMsg in messages)
        {
            try
            {
                await DispatchAsync(outboxMsg, ct);
                outboxMsg.ProcessedAt = DateTime.UtcNow;
            }
            catch (Exception ex)
            {
                outboxMsg.RetryCount++;
                outboxMsg.Error = ex.Message;
                logger.LogWarning(ex, "Failed to process outbox message {Id}", outboxMsg.Id);
            }
        }

        await context.SaveChangesAsync(ct);
    }

    private async Task DispatchAsync(OutboxMessage message, CancellationToken ct)
    {
        // ✅ Idempotent dispatch — ProcessedAt check prevents double processing
        if (message.Type == nameof(MessageSentEvent))
        {
            var evt = System.Text.Json.JsonSerializer.Deserialize<MessageSentEvent>(message.Payload)!;
            await signalRNotifier.NotifyNewMessageAsync(evt.ConversationId, evt, ct);
        }
    }
}

// ❌ Wrong: side effect inside transaction — split brain guaranteed
public async Task SendMessageInsecureAsync(SendMessageRequest request, CancellationToken ct)
{
    await using var tx = await context.Database.BeginTransactionAsync(ct);
    context.Messages.Add(new Message { Content = request.Content });
    await context.SaveChangesAsync(ct);

    // BUG: SignalR fails → message saved but recipients never notified
    // OR: transaction rolls back → notification already sent for uncommitted data
    await signalRNotifier.NotifyAsync(request.ConversationId, request.Content, ct);

    await tx.CommitAsync(ct);
}
```

## The Trap

```csharp
// A senior developer implements the outbox pattern correctly.
// Atomic writes. Background processor. Ships.
// The trap: two background processor instances run simultaneously (scale-out).
// Both read the same unprocessed outbox messages.
// Both dispatch the same SignalR notification.
// Recipient sees duplicate messages.

// Fix: pessimistic lock on outbox message selection
private async Task ProcessBatchAsync(CancellationToken ct)
{
    // ✅ SELECT ... WITH (UPDLOCK, ROWLOCK) — only one processor claims each message
    var messages = await context.OutboxMessages
        .FromSqlRaw("""
            SELECT TOP 50 * FROM OutboxMessages WITH (UPDLOCK, ROWLOCK, READPAST)
            WHERE ProcessedAt IS NULL AND RetryCount < 5
            ORDER BY CreatedAt
            """)
        .ToListAsync(ct);

    // Alternative: use a distributed lock (Redis SETNX) before claiming the batch
    // Or: use MassTransit's built-in transactional outbox which handles this correctly
}

// Better alternative for production: use MassTransit with EF Core outbox
// services.AddMassTransit(x => {
//     x.AddEntityFrameworkOutbox<AppDbContext>(o => {
//         o.UseSqlServer();
//         o.UseBusOutbox();
//     });
// });
// MassTransit handles claiming, locking, retry, and deduplication correctly
```

## The Exception
For in-process side effects that are idempotent and failure-tolerant — for example, invalidating an in-memory cache after a DB write — the outbox pattern is unnecessary overhead. The outbox is critical when: (1) the side effect is external (email, SMS, webhook), (2) the side effect is not idempotent (creating a charge, sending a notification), or (3) the side effect must be guaranteed despite transient failures. Internal cache invalidation that self-heals is not worth the complexity of an outbox.

## Before You Merge
- Is the outbox message written in the same `SaveChangesAsync` call as the business entity — not in a separate transaction?
- Does the outbox processor use `UPDLOCK`/`READPAST` hints or a distributed lock to prevent duplicate processing across instances?
- Is there a maximum retry count on outbox messages — so permanently failing events do not loop forever?
- Are dispatched events idempotent — can they be safely re-dispatched if the processor crashes after dispatching but before marking as processed?
- Is there monitoring on outbox message age — an alert when messages are older than N minutes indicates the processor is stuck?
