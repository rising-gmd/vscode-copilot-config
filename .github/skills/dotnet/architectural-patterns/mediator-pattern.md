# Mediator Pattern
> Verified against: .NET 9 | C# 13 | MediatR 12.x
> Last reviewed: 2026-02-22

## The Law
Use MediatR to decouple request dispatch from handler implementation — but register pipeline behaviours explicitly and in the correct order, and never use `IMediator` as a service locator to bypass DI.

## Why This Kills You At Scale
A controller that injects 8 services directly to handle different operations becomes untestable without constructing all 8 dependencies. `IMediator` solves this — one dependency, any operation. But an `IMediator.Send()` call chain with no pipeline behaviours registered means every handler manually duplicates validation, logging, and transaction management. At 100k requests/day, missing a validation behaviour on one handler means invalid data hits the database — discovered only when a constraint violation surfaces three weeks later.

## The Pattern

```csharp
#nullable enable
using MediatR;
using FluentValidation;
using Microsoft.Extensions.Logging;

// ✅ Correct: pipeline behaviours — declared once, applied to every handler

// 1. Exception handling — outermost, wraps everything
public sealed class ExceptionHandlingBehaviour<TRequest, TResponse>(
    ILogger<ExceptionHandlingBehaviour<TRequest, TResponse>> logger)
    : IPipelineBehavior<TRequest, TResponse>
    where TRequest : notnull
{
    public async Task<TResponse> Handle(
        TRequest request,
        RequestHandlerDelegate<TResponse> next,
        CancellationToken ct)
    {
        try
        {
            return await next();
        }
        catch (Exception ex) when (ex is not AppException
                                       and not OperationCanceledException)
        {
            // Log unhandled exceptions — AppExceptions are expected business failures
            logger.LogError(ex,
                "Unhandled exception in handler for {RequestType}",
                typeof(TRequest).Name);
            throw; // Re-throw — GlobalExceptionHandler maps to 500
        }
    }
}

// 2. Logging behaviour — wraps validation and handler
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
        var sw = System.Diagnostics.Stopwatch.StartNew();

        logger.LogInformation("→ {RequestName}", requestName);

        var response = await next();

        sw.Stop();

        if (sw.ElapsedMilliseconds > 500)
        {
            logger.LogWarning("⚠ Slow {RequestName} completed in {ElapsedMs}ms",
                requestName, sw.ElapsedMilliseconds);
        }
        else
        {
            logger.LogInformation("✓ {RequestName} completed in {ElapsedMs}ms",
                requestName, sw.ElapsedMilliseconds);
        }

        return response;
    }
}

// 3. Validation behaviour — runs before handler
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
        if (!validators.Any()) return await next();

        var context = new ValidationContext<TRequest>(request);

        var failures = validators
            .Select(v => v.Validate(context))
            .SelectMany(r => r.Errors)
            .Where(f => f != null)
            .ToList();

        if (failures.Count > 0)
            throw new FluentValidation.ValidationException(failures);

        return await next();
    }
}

// ✅ Correct: registration in Program.cs — ORDER MATTERS
builder.Services.AddMediatR(cfg =>
{
    cfg.RegisterServicesFromAssembly(typeof(SendMessageCommand).Assembly);

    // Outermost first — exception handler wraps everything
    cfg.AddBehavior(typeof(IPipelineBehavior<,>),
        typeof(ExceptionHandlingBehaviour<,>));

    // Then logging — logs before and after validation + handler
    cfg.AddBehavior(typeof(IPipelineBehavior<,>),
        typeof(LoggingBehaviour<,>));

    // Then validation — runs before handler, after logging starts
    cfg.AddBehavior(typeof(IPipelineBehavior<,>),
        typeof(ValidationBehaviour<,>));
});

// ✅ Correct: validators registered automatically via FluentValidation scan
builder.Services.AddValidatorsFromAssembly(
    typeof(SendMessageCommand).Assembly);

// ✅ Correct: thin controller — one dependency, any command or query
[ApiController]
[Route("api/[controller]")]
[Authorize]
public sealed class MessagesController(IMediator mediator) : ControllerBase
{
    [HttpPost]
    public async Task<IActionResult> Send(
        [FromBody] SendMessageRequest request,
        CancellationToken ct)
    {
        var command = new SendMessageCommand(
            request.ClientMessageId,
            request.ConversationId,
            request.Content,
            _currentUser.GetUserId());

        var messageId = await mediator.Send(command, ct);

        return CreatedAtAction(nameof(GetById), new { id = messageId },
            ApiResponse.Ok(new { id = messageId }));
    }
}

// ❌ Wrong: IMediator as service locator — bypasses DI, untestable
public sealed class BadService(IMediator mediator, IServiceProvider sp)
{
    public async Task DoSomethingAsync()
    {
        // Using IMediator to resolve arbitrary services — defeats the purpose
        var repo = sp.GetRequiredService<IMessageRepository>(); // Service locator anti-pattern
        await mediator.Send(new GetConversationQuery(Guid.NewGuid(), Guid.NewGuid()));
    }
}
```

## The Trap

```csharp
// A senior developer registers behaviours in MediatR correctly.
// Validation runs before every handler. Logging wraps everything. Ships.
// The trap: INotification handlers (domain events) also go through the pipeline.
// The ValidationBehaviour runs on every INotification.Publish() call.
// Domain events have no validators registered — ValidatorBehaviour returns immediately.
// Fine. But LoggingBehaviour logs every domain event handler invocation.
// A single request with 3 domain events produces 8 log entries:
// → SendMessageCommand, → MessageSentEvent (x3 handlers), ✓ MessageSentEvent (x3), ✓ SendMessageCommand
// Log volume doubles. In production with 2M requests/day: 16M unnecessary log entries.

// Fix: constrain pipeline behaviours to IRequest (commands/queries) only,
// not INotification (domain events)

public sealed class LoggingBehaviour<TRequest, TResponse>
    : IPipelineBehavior<TRequest, TResponse>
    where TRequest : IRequest<TResponse> // ← Constrain to IRequest, not IBaseRequest
{
    // Only runs for commands and queries — not domain event notifications
}

// MediatR registration:
cfg.AddBehavior(typeof(IPipelineBehavior<,>), typeof(LoggingBehaviour<,>));
// With the generic constraint above, MediatR only applies it to IRequest<TResponse>
// Domain events (INotification) are excluded automatically

// This single constraint reduces log volume by 50-70% in a typical event-heavy system.
```

## The Exception
Simple internal tools, CLIs, and admin scripts that have a single entry point and a handful of operations gain nothing from MediatR — a direct service call is cleaner and more readable. MediatR pays off when: (1) controllers need to dispatch more than 3-4 different operation types, (2) cross-cutting pipeline concerns (validation, logging, caching) must be applied consistently across all operations, (3) domain events require decoupled handlers. The indirection cost is real — justify it with the complexity it manages.

## Before You Merge
- Are pipeline behaviours registered in the correct order — ExceptionHandling → Logging → Validation → Handler?
- Are behaviours constrained to `IRequest<TResponse>` — not applied to `INotification` domain events?
- Is `IMediator` injected only in controllers and entry points — not used as a service locator inside handlers?
- Does the `ValidationBehaviour` short-circuit (return `next()`) when no validators are registered for a request type?
- Are slow request warnings (> 500ms) logged at `Warning` level — so they surface in monitoring dashboards?
