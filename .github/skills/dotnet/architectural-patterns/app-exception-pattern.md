# App Exception Pattern
> Verified against: .NET 9 | C# 13 | ASP.NET Core 9.x
> Last reviewed: 2026-02-22

## The Law
Define a typed domain exception hierarchy mapped to HTTP status codes in the global exception handler — never return error responses directly from services or use generic `Exception` to signal business rule violations.

## Why This Kills You At Scale
A service that returns `null` to signal "not found" and throws `Exception("Unauthorized")` to signal authorization failure forces every caller to interpret return values and catch untyped exceptions — duplicating error mapping logic across 40 controllers. At 100k users, when you add a new error condition (account suspended, quota exceeded), you update 40 controller files instead of one exception class and one handler line. Consistency breaks within weeks as developers add their own patterns.

## The Pattern

```csharp
#nullable enable
using Microsoft.AspNetCore.Diagnostics;
using Microsoft.AspNetCore.Mvc;

// ✅ Correct: typed exception hierarchy — one exception = one HTTP status code
// Lives in Application or SharedKernel layer — no framework dependencies

public abstract class AppException(string code, string message, int httpStatusCode)
    : Exception(message)
{
    public string Code { get; } = code;
    public int HttpStatusCode { get; } = httpStatusCode;
    public Dictionary<string, object> Metadata { get; } = [];

    public AppException WithMetadata(string key, object value)
    {
        Metadata[key] = value;
        return this;
    }
}

// ✅ Each subclass is self-documenting and maps to exactly one HTTP status
public sealed class NotFoundException(string message, string? code = null)
    : AppException(code ?? "NOT_FOUND", message, StatusCodes.Status404NotFound);

public sealed class ForbiddenException(string message, string? code = null)
    : AppException(code ?? "FORBIDDEN", message, StatusCodes.Status403Forbidden);

public sealed class UnauthorizedException(string message, string? code = null)
    : AppException(code ?? "UNAUTHORIZED", message, StatusCodes.Status401Unauthorized);

public sealed class ConflictException(string message, string? code = null)
    : AppException(code ?? "CONFLICT", message, StatusCodes.Status409Conflict);

public sealed class ValidationException(string message, string? code = null)
    : AppException(code ?? "VALIDATION_ERROR", message, StatusCodes.Status400BadRequest);

public sealed class RateLimitException(string message, int retryAfterSeconds = 60)
    : AppException("RATE_LIMIT_EXCEEDED", message, StatusCodes.Status429TooManyRequests)
{
    public int RetryAfterSeconds { get; } = retryAfterSeconds;
}

public sealed class DomainException(string message, string? code = null)
    : AppException(code ?? "DOMAIN_ERROR", message, StatusCodes.Status422UnprocessableEntity);

// ✅ Correct: global exception handler — one place maps all exceptions to HTTP
public sealed class GlobalExceptionHandler(ILogger<GlobalExceptionHandler> logger)
    : IExceptionHandler
{
    public async ValueTask<bool> TryHandleAsync(
        HttpContext context,
        Exception exception,
        CancellationToken ct)
    {
        var (statusCode, code, message, metadata) = exception switch
        {
            OperationCanceledException =>
                (499, "REQUEST_CANCELLED", "Request was cancelled", null),

            AppException appEx =>
                (appEx.HttpStatusCode, appEx.Code, appEx.Message,
                 appEx.Metadata.Count > 0 ? appEx.Metadata : null),

            _ =>
                (500, "INTERNAL_SERVER_ERROR", "An unexpected error occurred", null)
        };

        // Log only genuine server errors — not domain exceptions (those are expected)
        if (statusCode >= 500)
        {
            logger.LogError(exception,
                "Unhandled exception: {Code} - {Message}", code, message);
        }
        else if (statusCode != 499) // Don't log client cancellations
        {
            logger.LogWarning("Domain exception: {Code} - {Message}", code, message);
        }

        // Add Retry-After header for rate limit responses
        if (exception is RateLimitException rateLimitEx)
            context.Response.Headers.RetryAfter = rateLimitEx.RetryAfterSeconds.ToString();

        context.Response.StatusCode = statusCode;

        var problemDetails = new ProblemDetails
        {
            Status = statusCode,
            Title = code,
            Detail = message,
            Instance = context.Request.Path
        };

        if (metadata is not null)
            foreach (var (key, value) in metadata)
                problemDetails.Extensions[key] = value;

        await context.Response.WriteAsJsonAsync(problemDetails, ct);
        return true;
    }
}

// ✅ Correct: register in Program.cs
// builder.Services.AddExceptionHandler<GlobalExceptionHandler>();
// builder.Services.AddProblemDetails();
// app.UseExceptionHandler();

// ✅ Correct: usage in services — throw, never return null to signal failure
public sealed class MessageService(IMessageRepository repo)
{
    public async Task<MessageDto> GetByIdAsync(Guid id, Guid requestingUserId, CancellationToken ct)
    {
        var message = await repo.GetByIdAsync(id, ct)
            ?? throw new NotFoundException($"Message {id} not found");

        if (message.SenderId != requestingUserId)
            throw new ForbiddenException("Access to this message is not permitted");

        return message.ToDto();
    }

    public async Task DeleteAsync(Guid id, Guid requestingUserId, CancellationToken ct)
    {
        var message = await repo.GetByIdAsync(id, ct)
            ?? throw new NotFoundException($"Message {id} not found");

        if (message.SenderId != requestingUserId)
            throw new ForbiddenException("Only the sender can delete this message");

        message.SoftDelete(requestingUserId);
        await _unitOfWork.SaveChangesAsync(ct);
    }
}

// ❌ Wrong: returning null for not found — callers must check, often don't
public async Task<MessageDto?> GetByIdInsecureAsync(Guid id, CancellationToken ct)
{
    return await repo.GetByIdAsync(id, ct) is { } message
        ? message.ToDto()
        : null; // Caller forgets null check — NullReferenceException in production
}

// ❌ Wrong: generic exception with magic strings
throw new Exception("NOT_FOUND"); // Controller must string-match to map status code
throw new Exception("403");       // Magic numbers — breaks silently if code changes
```

## The Trap

```csharp
// A senior developer implements the exception hierarchy correctly.
// Global handler maps every exception to the right status code.
// ProblemDetails format. Ships.
// The trap: FluentValidation's ValidationException conflicts with the custom one.

// FluentValidation throws: FluentValidation.ValidationException
// Custom hierarchy has: ValidationException (inherits AppException)
// They are DIFFERENT types with the SAME name.

// The global exception handler pattern-matches on AppException first.
// FluentValidation's ValidationException does NOT inherit AppException.
// The catch-all maps it to 500 — every validation failure returns 500.
// In development: tiny sample data passes validation, never seen.
// In production: first real user submits invalid data, gets 500.

// Fix: handle FluentValidation.ValidationException explicitly in the handler
public async ValueTask<bool> TryHandleAsync(
    HttpContext context,
    Exception exception,
    CancellationToken ct)
{
    var (statusCode, code, message) = exception switch
    {
        OperationCanceledException => (499, "REQUEST_CANCELLED", "Request cancelled"),

        // ✅ FluentValidation's exception — must be before generic Exception
        FluentValidation.ValidationException fvEx => (
            StatusCodes.Status400BadRequest,
            "VALIDATION_ERROR",
            string.Join("; ", fvEx.Errors.Select(e => e.ErrorMessage))),

        AppException appEx =>
            (appEx.HttpStatusCode, appEx.Code, appEx.Message),

        _ => (500, "INTERNAL_SERVER_ERROR", "An unexpected error occurred")
    };

    // ... rest of handler
    return true;
}
```

## The Exception
Worker services, console tools, and Hangfire background jobs that do not produce HTTP responses do not map exceptions to HTTP status codes — but they still benefit from the typed exception hierarchy for logging and retry decisions. A `NotFoundException` in a background job means "skip this item, data is gone." A `DomainException` means "this item is permanently invalid, do not retry." The exception type carries semantic meaning beyond HTTP — retain the hierarchy, drop only the HTTP mapping.

## Before You Merge
- Is there a single `GlobalExceptionHandler` registered via `AddExceptionHandler<T>()` — no try/catch in controllers?
- Does each typed exception map to exactly one HTTP status code — hardcoded in the exception class, not in the handler?
- Is `FluentValidation.ValidationException` handled explicitly before the catch-all — preventing 500s for validation failures?
- Are `OperationCanceledException` responses returning 499 — not 500 — so monitoring dashboards show clean error rates?
- Do services throw typed exceptions for all failure conditions — never returning null to signal not-found?
