# Global Exception Handler
> Verified against: .NET 9 | C# 13 | ASP.NET Core 9.x
> Last reviewed: 2026-02-22

## The Law
Handle all exceptions in a single `IExceptionHandler` implementation — zero `try-catch` blocks in controllers, zero duplicated error response logic across endpoints.

## Why This Kills You At Scale
Exception handling scattered across 50 controllers produces 50 different error response formats — some return `{ "error": "..." }`, some return `{ "message": "..." }`, some return raw strings. At 100k users, your Angular client must handle every format variant. A new developer adds endpoint 51 with a different format. The mobile app breaks. A centralized handler enforces a single contract that clients depend on.

## The Pattern

```csharp
#nullable enable
using Microsoft.AspNetCore.Diagnostics;
using Microsoft.AspNetCore.Mvc;

// ✅ Correct: single IExceptionHandler implementation — .NET 8+ built-in
public sealed class GlobalExceptionHandler(ILogger<GlobalExceptionHandler> logger)
    : IExceptionHandler
{
    public async ValueTask<bool> TryHandleAsync(
        HttpContext httpContext,
        Exception exception,
        CancellationToken cancellationToken)
    {
        var (statusCode, title, detail, extensions) = MapException(exception);

        // ✅ Log unhandled exceptions with full context
        if (statusCode >= 500)
        {
            logger.LogError(exception,
                "Unhandled exception — TraceId: {TraceId} | Path: {Path}",
                httpContext.TraceIdentifier,
                httpContext.Request.Path);
        }
        else
        {
            logger.LogWarning(exception,
                "Handled exception — {StatusCode} | Path: {Path}",
                statusCode, httpContext.Request.Path);
        }

        // ✅ RFC 7807 ProblemDetails — standard format all clients can depend on
        var problemDetails = new ProblemDetails
        {
            Status = statusCode,
            Title = title,
            Detail = detail,
            Instance = httpContext.Request.Path,
        };

        problemDetails.Extensions["traceId"] = httpContext.TraceIdentifier;

        if (extensions is not null)
        {
            foreach (var (key, value) in extensions)
                problemDetails.Extensions[key] = value;
        }

        httpContext.Response.StatusCode = statusCode;
        await httpContext.Response.WriteAsJsonAsync(problemDetails, cancellationToken);

        return true; // Handled — do not propagate
    }

    private static (int statusCode, string title, string detail, Dictionary<string, object>? extensions)
        MapException(Exception exception) => exception switch
    {
        AppException ex => (MapAppExceptionToStatusCode(ex.Code), ex.Code, ex.Message,
            ex.Data?.Count > 0 ? ex.Data.Cast<System.Collections.DictionaryEntry>()
                .ToDictionary(e => e.Key.ToString()!, e => e.Value ?? (object)"") : null),

        NotFoundException ex => (StatusCodes.Status404NotFound, "NOT_FOUND", ex.Message, null),

        UnauthorizedException ex => (StatusCodes.Status401Unauthorized, "UNAUTHORIZED", ex.Message, null),

        ConflictException ex => (StatusCodes.Status409Conflict, "CONFLICT", ex.Message, null),

        ValidationException ex => (StatusCodes.Status400BadRequest, "VALIDATION_ERROR",
            "One or more validation errors occurred",
            new Dictionary<string, object> { ["errors"] = ex.Errors }),

        OperationCanceledException => (StatusCodes.Status499ClientClosedRequest,
            "REQUEST_CANCELLED", "The request was cancelled", null),

        // ✅ Never expose internal details in 500 responses
        _ => (StatusCodes.Status500InternalServerError, "INTERNAL_ERROR",
            "An unexpected error occurred. Please try again.", null)
    };

    private static int MapAppExceptionToStatusCode(string code) => code switch
    {
        "INVALID_CREDENTIALS" or "TOKEN_INVALID" or "TOKEN_EXPIRED" => 401,
        "ACCOUNT_LOCKED" => 423,
        "EMAIL_NOT_VERIFIED" => 403,
        "TOO_MANY_RESEND_ATTEMPTS" => 429,
        "EMAIL_ALREADY_VERIFIED" => 409,
        "ACCOUNT_INACTIVE" => 403,
        _ => 400
    };
}

// ✅ Correct: register in Program.cs
builder.Services.AddExceptionHandler<GlobalExceptionHandler>();
builder.Services.AddProblemDetails();

app.UseExceptionHandler(); // Must be early in pipeline

// ✅ Correct: custom exception types in Application layer
public class AppException(string code, string message, Dictionary<string, object>? data = null)
    : Exception(message)
{
    public string Code { get; } = code;
    public new Dictionary<string, object>? Data { get; } = data;
}

public class NotFoundException(string message) : Exception(message);
public class UnauthorizedException(string message) : Exception(message);
public class ConflictException(string message, string? currentTitle = null) : Exception(message)
{
    public string? CurrentTitle { get; } = currentTitle;
}
```

## The Trap

```csharp
// A senior developer sets up GlobalExceptionHandler correctly.
// All exceptions handled. Ships.
// The trap: FluentValidation failures are NOT routed through IExceptionHandler.
// They are handled by ASP.NET Core's model validation pipeline and return
// a default ValidationProblemDetails before the exception handler sees anything.

// Result: most errors return your custom ProblemDetails format.
// Validation errors return ASP.NET Core's default format — different structure.
// Angular client handles two different error schemas.

// Fix: configure the validation pipeline to produce the same format
builder.Services.AddControllers()
    .ConfigureApiBehaviorOptions(options =>
    {
        options.InvalidModelStateResponseFactory = context =>
        {
            var errors = context.ModelState
                .Where(e => e.Value?.Errors.Count > 0)
                .ToDictionary(
                    e => e.Key,
                    e => e.Value!.Errors.Select(err => err.ErrorMessage).ToArray());

            var problemDetails = new ValidationProblemDetails(context.ModelState)
            {
                Status = StatusCodes.Status400BadRequest,
                Title = "VALIDATION_ERROR",
                Detail = "One or more validation errors occurred",
                Instance = context.HttpContext.Request.Path
            };

            problemDetails.Extensions["traceId"] = context.HttpContext.TraceIdentifier;

            return new BadRequestObjectResult(problemDetails)
            {
                ContentTypes = { "application/problem+json" }
            };
        };
    });
```

## The Exception
Background jobs and Hangfire workers run outside the HTTP pipeline — `IExceptionHandler` does not apply. These require their own exception handling: `UseHangfireServer` with a global job filter, or try-catch in the job method that logs, records failure, and optionally re-enqueues with backoff. The global exception handler is an HTTP concern only — document the separate strategy for background job failures explicitly.

## Before You Merge
- Is `IExceptionHandler` registered and `app.UseExceptionHandler()` called before `UseRouting`?
- Do 500-level responses contain zero internal exception details, stack traces, or SQL error messages?
- Does `InvalidModelStateResponseFactory` produce the same `ProblemDetails` format as the exception handler?
- Is `OperationCanceledException` handled explicitly — not logged as an error when the client disconnects?
- Are all custom exception types defined in the Application layer — not in the API or Infrastructure layer?
