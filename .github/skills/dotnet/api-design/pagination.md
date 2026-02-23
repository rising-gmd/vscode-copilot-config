# Pagination
> Verified against: .NET 9 | C# 13 | EF Core 9.x
> Last reviewed: 2026-02-22

## The Law
Return paginated responses for every collection endpoint — never return unbounded lists, and enforce server-side page size limits regardless of what the client requests.

## Why This Kills You At Scale
`GET /api/conversations` with no pagination returns all conversations for every user. One user with 10,000 conversations causes your API to load 10,000 entities from DB, serialize them to JSON, and send a 2MB response — while holding a DB connection and allocating memory for the entire result set. At 100k users, 100 such requests simultaneously exhausts your DB connection pool and your app server's memory. This is consistently the first scaling failure in new chat applications.

## The Pattern

```csharp
#nullable enable
using Microsoft.AspNetCore.Mvc;

// ✅ Correct: typed paginated response — consistent across all collection endpoints
public sealed record PagedResult<T>(
    IReadOnlyList<T> Items,
    string? NextCursor,    // null = no more pages
    int PageSize,
    bool HasNextPage)
{
    public static PagedResult<T> Empty(int pageSize) =>
        new([], null, pageSize, false);
}

// ✅ Correct: cursor-based pagination (preferred for large datasets)
// See: keyset-pagination.md for the DB query implementation
[HttpGet]
[ProducesResponseType<PagedResult<ConversationDto>>(StatusCodes.Status200OK)]
public async Task<ActionResult<PagedResult<ConversationDto>>> GetAll(
    [FromQuery] string? cursor,
    [FromQuery] int pageSize = 20,
    CancellationToken ct = default)
{
    // ✅ Server enforces limits — client cannot request arbitrary page sizes
    pageSize = Math.Clamp(pageSize, 1, 100);

    // Decode cursor from opaque base64 — prevents clients from constructing arbitrary cursors
    MessageCursor? decodedCursor = null;
    if (cursor is not null)
    {
        try
        {
            var json = System.Text.Encoding.UTF8.GetString(Convert.FromBase64String(cursor));
            decodedCursor = System.Text.Json.JsonSerializer.Deserialize<MessageCursor>(json);
        }
        catch
        {
            return BadRequest(new ProblemDetails
            {
                Title = "INVALID_CURSOR",
                Detail = "The provided cursor is invalid",
                Status = 400
            });
        }
    }

    var result = await _conversationService.GetPagedAsync(decodedCursor, pageSize, ct);

    // ✅ Encode cursor as opaque base64 — hides internal structure from clients
    string? nextCursorEncoded = null;
    if (result.NextCursor is not null)
    {
        var json = System.Text.Json.JsonSerializer.Serialize(result.NextCursor);
        nextCursorEncoded = Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(json));
    }

    return Ok(new PagedResult<ConversationDto>(
        result.Items,
        nextCursorEncoded,
        pageSize,
        result.NextCursor is not null));
}

// ✅ Correct: offset pagination for admin/reporting (acceptable for bounded datasets)
[HttpGet("admin/users")]
[Authorize(Roles = "Admin")]
[ProducesResponseType<OffsetPagedResult<UserDto>>(StatusCodes.Status200OK)]
public async Task<ActionResult<OffsetPagedResult<UserDto>>> GetUsers(
    [FromQuery] int page = 1,
    [FromQuery] int pageSize = 50,
    CancellationToken ct = default)
{
    page = Math.Max(1, page);
    pageSize = Math.Clamp(pageSize, 1, 200); // Admin can request larger pages

    var (users, totalCount) = await _userService.GetPagedAsync(page, pageSize, ct);
    var totalPages = (int)Math.Ceiling(totalCount / (double)pageSize);

    return Ok(new OffsetPagedResult<UserDto>(users, page, pageSize, totalCount, totalPages));
}

public sealed record OffsetPagedResult<T>(
    IReadOnlyList<T> Items,
    int Page,
    int PageSize,
    int TotalCount,
    int TotalPages);

// ❌ Wrong: unbounded collection — loads everything
[HttpGet("all-messages")]
public async Task<ActionResult<List<MessageDto>>> GetAllMessages(CancellationToken ct)
{
    // Will load 10M messages into memory for a large tenant
    return Ok(await _messageService.GetAllAsync(ct));
}

// ❌ Wrong: client controls page size without server limit
[HttpGet]
public async Task<IActionResult> GetWithNoLimit([FromQuery] int pageSize, CancellationToken ct)
{
    // Client sends pageSize=1000000 — DB loads a million rows
    return Ok(await _service.GetPagedAsync(null, pageSize, ct));
}
```

## The Trap

```csharp
// A senior developer correctly implements cursor pagination.
// Enforces page size. Ships.
// The trap: Angular's infinite scroll implementation makes N requests simultaneously
// when the user scrolls quickly — each fetching the "next page" with the same cursor.

// User scrolls fast → Angular fires 3 simultaneous requests with cursor=X
// All 3 return the same page → 3 duplicate pages appended to the UI
// User sees repeated messages

// Fix: Angular side (for reference) — deduplication and in-flight tracking
// isLoading = true before request, isLoading = false after
// Don't fire new request if isLoading is true
// Or: use exhaustMap instead of mergeMap in the scroll observable

// API side fix: make cursor consumption idempotent — same cursor always returns same page
// This is naturally true for cursor pagination (cursor is a position, not consumed)
// The UI deduplication must happen client-side

// Second trap: returning totalCount with cursor pagination
// Total count requires a COUNT(*) query — expensive on large tables
// Cursor pagination is designed to avoid knowing total count
// If you need totalCount with cursor pagination, you are solving the wrong problem:
// Use offset pagination (with its scalability tradeoffs) or don't show "X of Y" in UI
```

## The Exception
Export/download endpoints that deliberately return all data (CSV export, full backup) are exempt — but they must be: rate-limited to 1 request per minute per user, streamed using `IAsyncEnumerable` rather than loaded into memory, authenticated and authorized, and protected by a background job pattern for datasets over 10,000 rows. "Export all" is a legitimate operation — it just cannot be a synchronous HTTP response that loads the dataset into application memory.

## Before You Merge
- Does every collection endpoint have a `pageSize` parameter with a server-enforced maximum?
- Are cursors encoded as opaque base64 — so clients cannot construct arbitrary values?
- Are invalid cursors returning `400 Bad Request` with a clear error message — not `500`?
- Does offset pagination return `totalCount` and `totalPages` — so clients can render page controls?
- Are there zero endpoints that return unbounded `List<T>` for user-accessible collections?
