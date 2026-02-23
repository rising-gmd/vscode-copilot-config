# HTTP Status Codes
> Verified against: .NET 9 | C# 13 | ASP.NET Core 9.x
> Last reviewed: 2026-02-22

## The Law
HTTP status codes are the contract — use them semantically, not as suggestions. `200` means success. `4xx` means client error. `5xx` means server error. Never return `200` for a failure or `500` for a client mistake.

## Why This Kills You At Scale
A mobile client uses HTTP status code to decide whether to retry a request — `5xx` triggers retry logic, `4xx` does not. If you return `200` for validation errors, the client has no way to distinguish success from failure without parsing the body. At 100k users, misused status codes produce clients that retry requests that should never be retried (worsening load) and don't retry requests that should be (losing user actions). Every inconsistency becomes a category of support ticket.

## The Pattern

```csharp
#nullable enable
using Microsoft.AspNetCore.Mvc;

[ApiController]
[Route("api/v{version:apiVersion}/[controller]")]
public sealed class ExamplesController : ControllerBase
{
    // ✅ 200 OK — successful GET, PUT, PATCH with response body
    [HttpGet("{id:guid}")]
    public async Task<ActionResult<ResourceDto>> GetById(Guid id, CancellationToken ct)
    {
        var resource = await _service.GetByIdAsync(id, ct);
        return resource is null ? NotFound() : Ok(resource); // 200 or 404
    }

    // ✅ 201 Created — successful POST that creates a resource
    [HttpPost]
    public async Task<ActionResult<ResourceDto>> Create(
        [FromBody] CreateRequest request, CancellationToken ct)
    {
        var resource = await _service.CreateAsync(request, ct);
        // 201 + Location header pointing to the new resource
        return CreatedAtAction(nameof(GetById), new { id = resource.Id }, resource);
    }

    // ✅ 204 No Content — successful DELETE or action with no response body
    [HttpDelete("{id:guid}")]
    public async Task<IActionResult> Delete(Guid id, CancellationToken ct)
    {
        await _service.DeleteAsync(id, ct);
        return NoContent(); // 204
    }

    // ✅ 202 Accepted — request received, processing asynchronously
    [HttpPost("{id:guid}/export")]
    public IActionResult Export(Guid id)
    {
        _backgroundJobDispatcher.EnqueueExport(id);
        // 202 + location of the job status endpoint
        return AcceptedAtAction(nameof(GetExportStatus), new { id }, new { jobId = id });
    }

    // ✅ Status code reference — use these, never invent new semantics
    // 200 OK           — success with body (GET, PUT, PATCH)
    // 201 Created      — resource created (POST)
    // 202 Accepted     — async operation started
    // 204 No Content   — success without body (DELETE, fire-and-forget POST)
    // 400 Bad Request  — client sent invalid data (validation failure)
    // 401 Unauthorized — not authenticated (no/invalid token)
    // 403 Forbidden    — authenticated but not authorized (wrong role/ownership)
    // 404 Not Found    — resource doesn't exist (or intentional: don't reveal existence)
    // 409 Conflict     — state conflict (duplicate, optimistic concurrency, already exists)
    // 410 Gone         — resource existed but was deleted (use over 404 when you want to signal deletion)
    // 422 Unprocessable— validation passed but business rule failed (e.g., insufficient funds)
    // 423 Locked       — resource locked (account lockout)
    // 429 Too Many     — rate limit exceeded
    // 499 Client Closed— client disconnected (log as info, not error)
    // 500 Internal     — unexpected server error
    // 502 Bad Gateway  — upstream dependency failed
    // 503 Unavailable  — server overloaded or in maintenance
}

// ❌ Wrong: 200 for all responses — forces clients to parse body for status
public IActionResult LoginBad([FromBody] LoginRequest request)
{
    if (request.Email is null)
        return Ok(new { success = false, error = "Email required" }); // Should be 400

    // ...
    return Ok(new { success = true, token = "..." }); // Should be 200 with token in cookie
}

// ❌ Wrong: 500 for client errors
public IActionResult CreateBad([FromBody] CreateRequest request)
{
    if (string.IsNullOrEmpty(request.Title))
        throw new Exception("Title required"); // Produces 500 — client's fault, should be 400
    // ...
}
```

## The Trap

```csharp
// A senior developer uses correct status codes everywhere.
// Mobile client implements retry logic based on status codes.
// Ships.
// The trap: 401 vs 403 confusion causes infinite retry loops.

// The confusion:
// 401 Unauthorized — "you are not authenticated" — retry after re-authenticating
// 403 Forbidden    — "you ARE authenticated but not allowed" — do NOT retry, it will still be 403

// Common mistake: returning 401 when the user is authenticated but not authorized
public async Task<IActionResult> GetMessage(Guid messageId, CancellationToken ct)
{
    var message = await _service.GetByIdAsync(messageId, ct);
    if (message is null) return NotFound();

    if (message.SenderId != User.GetUserId())
        return Unauthorized(); // BUG: user IS authenticated — this should be 403 or 404

    return Ok(message);
}

// Correct:
public async Task<IActionResult> GetMessageCorrect(Guid messageId, CancellationToken ct)
{
    var message = await _service.GetByIdAsync(messageId, ct);
    if (message is null) return NotFound();

    if (message.SenderId != User.GetUserId())
        return NotFound(); // 404 preferred — don't reveal the message exists to unauthorized users
        // Or: return Forbid(); // 403 if you want to be explicit about authorization failure

    return Ok(message);
}

// The mobile client retry rule:
// 401 → refresh token → retry once → if still 401, redirect to login
// 403 → show "access denied" — NEVER retry (permission won't change without admin action)
// 404 → show "not found" — NEVER retry
// 429 → back off and retry after Retry-After header value
// 5xx → retry with exponential backoff (max 3 times)
```

## The Exception
Some legacy clients (particularly enterprise middleware) treat any non-200 response as an error and cannot be updated. If you must maintain a legacy compatibility mode, add a `?compat=legacy` query parameter that wraps responses in a `{ success, data, error }` envelope with always-200 status — but serve proper RFC-compliant responses by default. Never make the legacy format the default; make it opt-in and document the sunset date.

## Before You Merge
- Do `POST` endpoints that create resources return `201 Created` with a `Location` header — not `200 OK`?
- Do `DELETE` endpoints return `204 No Content` — not `200 OK` with an empty body?
- Is `401` used only for unauthenticated requests and `403` for authenticated-but-unauthorized — never swapped?
- Are `500` responses reserved for genuinely unexpected errors — no client validation failures returning `500`?
- Is `429 Too Many Requests` accompanied by a `Retry-After` header — not just a status code?
