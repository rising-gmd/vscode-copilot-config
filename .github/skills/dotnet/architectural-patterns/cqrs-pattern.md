# CQRS Pattern
> Verified against: .NET 9 | C# 13 | MediatR 12.x
> Last reviewed: 2026-02-22

## The Law
Separate every operation into a Command (writes, no return value or returns only an ID) or a Query (reads, no side effects) — never mix read and write concerns in the same handler or service method.

## Why This Kills You At Scale
A `GetConversationAsync` method that also updates `LastViewedAt` as a side effect runs that update on every read — at 100k users opening conversations 20 times a day, that is 2 million unnecessary writes per day creating write contention on the `Conversations` table, blocking legitimate writes, and making read replicas useless because reads have writes embedded in them. You cannot route queries to a read replica if they contain writes.

## The Pattern

```csharp
#nullable enable
using MediatR;

// ✅ Correct: Query — pure read, no side effects, can run on read replica
public sealed record GetConversationQuery(Guid ConversationId, Guid RequestingUserId)
    : IRequest<ConversationDto>;

public sealed class GetConversationHandler(
    IDapperConversationRepository repo) // Dapper for reads — fast projections
    : IRequestHandler<GetConversationQuery, ConversationDto>
{
    public async Task<ConversationDto> Handle(
        GetConversationQuery query,
        CancellationToken ct)
    {
        // ✅ Pure read — no writes, no side effects
        var conversation = await repo.GetByIdAsync(query.ConversationId, ct)
            ?? throw new NotFoundException($"Conversation {query.ConversationId} not found");

        if (!conversation.Participants.Any(p => p.UserId == query.RequestingUserId))
            throw new ForbiddenException("Not a member of this conversation");

        return conversation;
    }
}

// ✅ Correct: Command — write operation, returns only created ID or void
public sealed record SendMessageCommand(
    Guid ConversationId,
    Guid SenderId,
    string Content,
    Guid ClientMessageId) // Idempotency key
    : IRequest<Guid>; // Returns only the ID — not the full entity

public sealed class SendMessageHandler(
    IMessageRepository messageRepo,
    IConversationRepository convRepo,
    IUnitOfWork unitOfWork,
    IRealTimeNotifier notifier)
    : IRequestHandler<SendMessageCommand, Guid>
{
    public async Task<Guid> Handle(SendMessageCommand command, CancellationToken ct)
    {
        // ✅ Idempotency — safe to retry with same ClientMessageId
        var existing = await messageRepo.GetByClientIdAsync(command.ClientMessageId, ct);
        if (existing is not null) return existing.Id;

        if (!await convRepo.IsUserMemberAsync(command.ConversationId, command.SenderId, ct))
            throw new ForbiddenException("Not a member of this conversation");

        var message = Message.Create(
            command.ConversationId,
            command.SenderId,
            command.Content);

        await messageRepo.AddAsync(message, ct);
        await unitOfWork.SaveChangesAsync(ct);

        await notifier.NotifyMessageSentAsync(
            command.ConversationId,
            message.ToDto(),
            ct);

        return message.Id;
    }
}

// ✅ Correct: separate command for the side effect that was polluting the query
public sealed record MarkConversationViewedCommand(
    Guid ConversationId,
    Guid UserId)
    : IRequest;

public sealed class MarkConversationViewedHandler(
    IConversationRepository repo,
    IUnitOfWork unitOfWork)
    : IRequestHandler<MarkConversationViewedCommand>
{
    public async Task Handle(MarkConversationViewedCommand command, CancellationToken ct)
    {
        // Fire-and-forget from controller — does not block the UI response
        await repo.UpdateLastViewedAtAsync(command.ConversationId, command.UserId, ct);
        await unitOfWork.SaveChangesAsync(ct);
    }
}

// ✅ Correct: controller dispatches both — query first for UI, command fire-and-forget
[HttpGet("{conversationId:guid}")]
public async Task<IActionResult> GetConversation(Guid conversationId, CancellationToken ct)
{
    var userId = _currentUser.GetUserId();

    // Query — returns immediately with conversation data
    var conversation = await _mediator.Send(
        new GetConversationQuery(conversationId, userId), ct);

    // Command — fire and forget, does not block response
    _ = _mediator.Send(
        new MarkConversationViewedCommand(conversationId, userId),
        CancellationToken.None); // Separate token — do not cancel with request

    return Ok(ApiResponse.Ok(conversation));
}

// ✅ Correct: MediatR pipeline behaviours — cross-cutting concerns
public sealed class ValidationBehaviour<TRequest, TResponse>(
    IEnumerable<IValidator<TRequest>> validators)
    : IPipelineBehavior<TRequest, TResponse>
    where TRequest : notnull
{
    public async Task<TResponse> Handle(
        TRequest request,
        RequestHandlerDelegate<TResponse> next,
        CancellationToken ct)
    {
        var context = new ValidationContext<TRequest>(request);
        var failures = validators
            .Select(v => v.Validate(context))
            .SelectMany(r => r.Errors)
            .Where(f => f != null)
            .ToList();

        if (failures.Count > 0)
            throw new ValidationException(failures);

        return await next();
    }
}

// ✅ Correct: logging behaviour — wraps every handler automatically
public sealed class LoggingBehaviour<TRequest, TResponse>(
    ILogger<LoggingBehaviour<TRequest, TResponse>> logger)
    : IPipelineBehavior<TRequest, TResponse>
    where TRequest : notnull
{
    public async Task<TResponse> Handle(
        TRequest request,
        RequestHandlerDelegate<TResponse> next,
        CancellationToken ct)
    {
        var requestName = typeof(TRequest).Name;
        logger.LogInformation("Handling {RequestName}", requestName);
        var sw = System.Diagnostics.Stopwatch.StartNew();
        var response = await next();
        sw.Stop();
        logger.LogInformation("Handled {RequestName} in {ElapsedMs}ms",
            requestName, sw.ElapsedMilliseconds);
        return response;
    }
}

// ❌ Wrong: query with side effect — mixed concerns
public sealed class GetConversationWithSideEffectHandler
    : IRequestHandler<GetConversationQuery, ConversationDto>
{
    public async Task<ConversationDto> Handle(GetConversationQuery query, CancellationToken ct)
    {
        var conversation = await _repo.GetByIdAsync(query.ConversationId, ct);
        // BUG: write inside a query — cannot route to read replica, adds write latency
        await _repo.UpdateLastViewedAtAsync(query.ConversationId, query.RequestingUserId, ct);
        await _unitOfWork.SaveChangesAsync(ct);
        return conversation!.ToDto();
    }
}
```

## The Trap

```csharp
// A senior developer correctly separates queries and commands with MediatR.
// Pipeline behaviours handle validation and logging. Ships.
// The trap: MediatR's Send() swallows the CancellationToken in fire-and-forget.

// In the controller above: _ = _mediator.Send(command, CancellationToken.None);
// This is correct — but developers often write:
_ = _mediator.Send(command, ct); // BUG: ct is the HTTP request token

// When the HTTP request completes, ct is cancelled.
// The fire-and-forget command is cancelled mid-execution.
// LastViewedAt is never updated. No error. No log. Silent failure.
// Discovered when "unread message count" is always wrong.

// Rule: fire-and-forget commands ALWAYS use CancellationToken.None
// or a long-running CancellationToken from IHostApplicationLifetime.
// Never use the request's CancellationToken for background work.

// Also: unhandled exceptions in fire-and-forget _ = Task.Run(...) are silently swallowed.
// Always wrap in try/catch or use a proper background job system (Hangfire).
_ = SafeFireAndForget(
    _mediator.Send(new MarkConversationViewedCommand(conversationId, userId), CancellationToken.None),
    _logger);

static async Task SafeFireAndForget(Task task, ILogger logger)
{
    try { await task; }
    catch (Exception ex) { logger.LogWarning(ex, "Fire-and-forget command failed"); }
}
```

## The Exception
Simple CRUD microservices with no complex business logic do not need CQRS — a `UserProfileService` with `Get`, `Update`, `Delete` has no read/write scale asymmetry that justifies the pattern overhead. Introduce CQRS when: (1) read and write models diverge significantly, (2) you need to route reads to replicas, (3) the complexity of combined read/write services is genuinely hurting maintainability. Do not introduce MediatR as a default in every project — it adds indirection without value when queries and commands are trivially simple.

## Before You Merge
- Does every Query handler contain zero write operations — no `SaveChangesAsync`, no `ExecuteUpdateAsync`?
- Does every Command handler return only a scalar (ID, bool) or void — never a full entity or DTO?
- Are fire-and-forget command dispatches using `CancellationToken.None` — not the HTTP request token?
- Are unhandled exceptions in fire-and-forget operations caught and logged — not silently swallowed?
- Are MediatR pipeline behaviours registered in the correct order — Logging → Validation → Handler?
