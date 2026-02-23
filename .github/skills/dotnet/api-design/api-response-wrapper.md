# API Response Wrapper
> Verified against: .NET 9 | C# 13 | ASP.NET Core 9.x
> Last reviewed: 2026-02-22

## The Law
Do not wrap all API responses in a `{ success, data, error }` envelope — return the resource directly for `2xx` and `ProblemDetails` for errors. HTTP status codes are the envelope.

## Why This Kills You At Scale
A success envelope forces every client to unwrap every response before using the data, adds bytes to every payload, and defeats HTTP caching (caches cannot distinguish cached success from cached error without parsing the body). At 100k users, an extra 20 bytes per response at 1M requests/day is 20GB of unnecessary data transfer annually. More critically, it trains developers to ignore HTTP status codes and check `response.success` instead — which breaks retry logic, middleware, and every HTTP tool in existence.

## The Pattern

```csharp
#nullable enable
using Microsoft.AspNetCore.Mvc;

// ✅ Correct: return resource directly — HTTP status IS the envelope
[HttpGet("{id:guid}")]
public async Task<ActionResult<ConversationDto>> GetById(Guid id, CancellationToken ct)
{
    var conversation = await _service.GetByIdAsync(id, ct);
    // 200 OK with the resource directly — no wrapper
    return conversation is null ? NotFound() : Ok(conversation);
}

// Response: HTTP 200
// Body: { "id": "...", "title": "...", "lastMessageAt": "..." }
// Not: { "success": true, "data": { "id": "...", ... }, "error": null }

// ✅ Correct: collections — just the list or paged result
[HttpGet]
public async Task<ActionResult<PagedResult<ConversationDto>>> GetAll(
    [FromQuery] string? cursor,
    CancellationToken ct)
{
    return Ok(await _service.GetPagedAsync(cursor, 20, ct));
}

// Response: HTTP 200
// Body: { "items": [...], "nextCursor": "...", "hasNextPage": true }
// Not: { "success": true, "data": { "items": [...] }, "meta": {...} }

// ✅ Correct: errors return ProblemDetails (RFC 7807) — see problem-details.md
// Response: HTTP 400
// Body: { "type": "...", "title": "VALIDATION_ERROR", "status": 400, "detail": "..." }
// Content-Type: application/problem+json

// ✅ Correct: the ONE legitimate use case for a thin metadata wrapper
// When you need to return resource + out-of-band metadata (pagination, links)
// This is not a success envelope — it IS the resource shape
public sealed record PagedResult<T>(
    IReadOnlyList<T> Items,
    string? NextCursor,
    bool HasNextPage);
// This is fine: it IS the resource. The data and the metadata are one entity.

// ❌ Wrong: success envelope
[HttpGet("{id:guid}")]
public async Task<IActionResult> GetByIdBad(Guid id, CancellationToken ct)
{
    var conversation = await _service.GetByIdAsync(id, ct);

    // Forces clients to check success AND status code — double-parsing
    // HTTP caching cannot distinguish 200+{success:false} from 200+{success:true}
    // Swagger cannot document the actual resource schema cleanly
    return Ok(new
    {
        success = conversation is not null,
        data = conversation,
        error = conversation is null ? "Not found" : null
        // Returning 200 for a "not found" — correct response is 404
    });
}

// ✅ Correct: Angular HttpClient usage (for reference)
// Standard: http.get<ConversationDto>('/api/v1/conversations/id')
//   → success: response body IS the ConversationDto
//   → error: HttpErrorResponse.error IS the ProblemDetails
//
// Envelope: http.get<ApiResponse<ConversationDto>>('/api/v1/conversations/id')
//   → success: response.body.data is the ConversationDto (extra unwrap)
//   → error: response.body.success === false (parsing body for error detection)
//   → 404: returns 200 + { success: false } — Angular doesn't see it as error
```

## The Trap

```csharp
// A senior developer correctly returns direct responses.
// No envelopes. ProblemDetails for errors. Ships.
// The trap: a third-party API you integrate with uses an envelope.
// A junior developer assumes "this is the pattern" and adds an envelope to your API.

// Guard against this by making the no-envelope policy explicit in your API conventions document
// AND in an architecture test:

public sealed class ApiResponseShapeTests
{
    [Fact]
    public void NoControllerActionReturnsAnonymousSuccessEnvelope()
    {
        // Find all controller action methods
        var assembly = typeof(ConversationsController).Assembly;
        var controllerTypes = assembly.GetTypes()
            .Where(t => t.IsAssignableTo(typeof(ControllerBase)));

        foreach (var controllerType in controllerTypes)
        {
            var actions = controllerType.GetMethods(
                System.Reflection.BindingFlags.Public |
                System.Reflection.BindingFlags.Instance)
                .Where(m => m.GetCustomAttributes(typeof(HttpMethodAttribute), true).Any());

            foreach (var action in actions)
            {
                // This test is intentionally simple — it catches the most common violation
                // of returning anonymous objects with a "success" property
                var returnType = action.ReturnType;
                Assert.DoesNotContain("success", returnType.Name,
                    StringComparison.OrdinalIgnoreCase);
            }
        }
    }
}
```

## The Exception
If you are building a public SDK or partner API where you contractually guarantee a stable response schema, AND your partners have explicitly requested an envelope for their SDK generation tooling, AND you cannot change those partners — an envelope is an acceptable compromise. Document it as a legacy compatibility decision, mark it as deprecated in your internal standards, and do not apply it to any new APIs going forward. The envelope becomes a compatibility shim, not a design pattern.

## Before You Merge
- Do all `2xx` endpoints return the resource or collection directly — no `{ success, data, error }` wrapper?
- Do all error responses return `ProblemDetails` with `Content-Type: application/problem+json`?
- Does any action method return `Ok(new { success = true/false, ... })` — if yes, it must be refactored?
- Are `404 Not Found` responses returned as `NotFound()` — not as `Ok(new { success = false })`?
- Is this rule documented in the API conventions document and enforced by at least one architecture test?
