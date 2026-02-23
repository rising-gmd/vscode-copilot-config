# Problem Details (RFC 7807)
> Verified against: .NET 9 | C# 13 | ASP.NET Core 9.x
> Last reviewed: 2026-02-22

## The Law
All error responses must conform to RFC 7807 ProblemDetails format with `Content-Type: application/problem+json` — never return raw strings, custom JSON schemas, or inconsistent error structures.

## Why This Kills You At Scale
At 100k users across web, mobile, and third-party integrations, every client must parse your error responses. If your error format is inconsistent — some endpoints return `{ "error": "..." }`, others return `{ "message": "..." }`, others return `{ "errors": [] }` — every client must implement custom parsing for every endpoint. A single consistent ProblemDetails contract means one error-handling implementation across all clients, forever.

## The Pattern

```csharp
#nullable enable
using Microsoft.AspNetCore.Mvc;

// ✅ Correct: ProblemDetails — RFC 7807 standard fields
// {
//   "type": "https://yourapi.com/errors/invalid-credentials",
//   "title": "INVALID_CREDENTIALS",
//   "status": 401,
//   "detail": "The provided credentials are incorrect.",
//   "instance": "/api/auth/login",
//   "traceId": "00-abc123-def456-00",
//   "extensions": { "lockedUntil": "2024-01-01T00:00:00Z" }
// }

// ✅ Correct: typed ProblemDetails factory for consistent construction
public static class ProblemDetailsFactory
{
    public static ProblemDetails Create(
        int statusCode,
        string title,
        string detail,
        string instance,
        string traceId,
        Dictionary<string, object>? extensions = null)
    {
        var problem = new ProblemDetails
        {
            // Type URI — links to your error documentation page (or a well-known URI)
            Type = $"https://yourapi.com/errors/{title.ToLowerInvariant().Replace('_', '-')}",
            Status = statusCode,
            Title = title,
            Detail = detail,
            Instance = instance,
        };

        problem.Extensions["traceId"] = traceId;

        if (extensions is not null)
        {
            foreach (var (key, value) in extensions)
                problem.Extensions[key] = value;
        }

        return problem;
    }

    // ✅ Correct: validation problem details — consistent with RFC 7807
    public static ValidationProblemDetails CreateValidation(
        IDictionary<string, string[]> errors,
        string instance,
        string traceId)
    {
        var problem = new ValidationProblemDetails(errors)
        {
            Type = "https://yourapi.com/errors/validation-error",
            Status = StatusCodes.Status400BadRequest,
            Title = "VALIDATION_ERROR",
            Detail = "One or more validation errors occurred.",
            Instance = instance,
        };

        problem.Extensions["traceId"] = traceId;
        return problem;
    }
}

// ✅ Correct: register ProblemDetails services — .NET 8+ built-in support
builder.Services.AddProblemDetails(options =>
{
    options.CustomizeProblemDetails = context =>
    {
        context.ProblemDetails.Extensions["traceId"] =
            context.HttpContext.TraceIdentifier;
        context.ProblemDetails.Instance =
            context.HttpContext.Request.Path;
    };
});

// ✅ Correct: Content-Type header is set automatically by WriteAsJsonAsync with ProblemDetails
// If setting manually: "application/problem+json" — not "application/json"

// ❌ Wrong: inconsistent error shapes
[HttpPost("login")]
public IActionResult LoginBad()
{
    return BadRequest(new { error = "Invalid credentials" }); // Not RFC 7807
    // return BadRequest("Invalid credentials"); // Plain string — even worse
    // return StatusCode(400, new { msg = "Bad" }); // Custom schema — inconsistent
}

// ✅ Correct: let global exception handler produce ProblemDetails — controller throws
[HttpPost("login")]
public async Task<IActionResult> Login([FromBody] LoginRequest request, CancellationToken ct)
{
    // Throws AppException — global handler converts to ProblemDetails
    var result = await _authService.LoginAsync(request.Identifier, request.Password, ct);
    return Ok(new { result.UserId, result.Username });
}
```

## The Trap

```csharp
// A senior developer sets up ProblemDetails globally.
// All errors conform to RFC 7807. Ships.
// The trap: Angular HttpClient does not parse ProblemDetails automatically.
// The developer assumes Angular will deserialize the body into a typed object.
// In practice, Angular's error.error is the raw object — no type safety.

// Angular side (TypeScript, for reference):
// interface ProblemDetails {
//   type: string;
//   title: string;
//   status: number;
//   detail: string;
//   traceId: string;
//   [key: string]: unknown; // extensions
// }
//
// catchError((error: HttpErrorResponse) => {
//   const problem = error.error as ProblemDetails;
//   // Use problem.title for machine-readable code
//   // Use problem.detail for user-facing message
//   // Use problem.status for HTTP status
// })

// The second trap: returning 200 with an error body — "success envelope" anti-pattern
// { "success": false, "error": "Invalid credentials", "data": null }
// This is not RFC 7807 and forces clients to check body content, not HTTP status.
// HTTP status codes are the contract. 4xx = client error. 5xx = server error.
// Do not use 200 for errors — ever.

// ❌ Wrong: success envelope
public IActionResult LoginEnvelope([FromBody] LoginRequest request)
{
    return Ok(new
    {
        success = false,          // 200 status but error in body — contradictory
        error = "Invalid",
        data = (object?)null
    });
}
```

## The Exception
Health check endpoints (`/health`, `/ready`, `/live`) use a different response format defined by the health check specification — not ProblemDetails. These are consumed by orchestrators (Kubernetes, Azure App Service) that have fixed expectations for the response format. Do not apply ProblemDetails to health check routes.

## Before You Merge
- Is every error response a `ProblemDetails` or `ValidationProblemDetails` — no raw strings, no custom JSON schemas?
- Is `Content-Type: application/problem+json` set on all error responses — not `application/json`?
- Does every `ProblemDetails` response include `traceId` and `instance` in extensions?
- Is the `type` field a resolvable URI — not `null` or `about:blank`?
- Are `2xx` responses reserved for success — no error information in 200 responses?
