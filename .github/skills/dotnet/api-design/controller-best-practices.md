# Controller Best Practices
> Verified against: .NET 9 | C# 13 | ASP.NET Core 9.x
> Last reviewed: 2026-02-22

## The Law
Controllers are thin HTTP adapters — they validate, delegate to the application layer, and map results to HTTP responses. Zero business logic, zero data access, zero domain decisions.

## Why This Kills You At Scale
Business logic in controllers cannot be unit tested without a full HTTP stack. When the same logic needs to be called from a background job, a SignalR hub, or a gRPC endpoint, it must be duplicated or refactored under pressure. At 100k users with a team of 5, fat controllers become the #1 source of inconsistent behavior between endpoints that "should do the same thing."

## The Pattern

```csharp
#nullable enable
using Microsoft.AspNetCore.Mvc;

[ApiController]
[Route("api/[controller]")]
[Produces("application/json")]
public sealed class ConversationsController(IConversationService conversationService) : ControllerBase
{
    // ✅ Correct: thin — validate input, delegate, map response
    [HttpGet("{id:guid}")]
    [ProducesResponseType<ConversationDto>(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<ConversationDto>> GetById(
        Guid id,
        CancellationToken ct)
    {
        var result = await conversationService.GetByIdAsync(id, ct);
        return result is null ? NotFound() : Ok(result);
    }

    // ✅ Correct: command pattern — request maps directly to service method
    [HttpPost]
    [ProducesResponseType<ConversationDto>(StatusCodes.Status201Created)]
    [ProducesResponseType<ValidationProblemDetails>(StatusCodes.Status400BadRequest)]
    public async Task<ActionResult<ConversationDto>> Create(
        [FromBody] CreateConversationRequest request,
        CancellationToken ct)
    {
        var conversation = await conversationService.CreateAsync(request, ct);
        // ✅ Return 201 Created with Location header — correct REST semantics
        return CreatedAtAction(nameof(GetById), new { id = conversation.Id }, conversation);
    }

    // ✅ Correct: no logic — just route and delegate
    [HttpDelete("{id:guid}")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<IActionResult> Delete(Guid id, CancellationToken ct)
    {
        await conversationService.DeleteAsync(id, ct);
        return NoContent();
    }

    // ✅ Correct: pagination parameters via [FromQuery] with defaults
    [HttpGet]
    [ProducesResponseType<PagedResult<ConversationDto>>(StatusCodes.Status200OK)]
    public async Task<ActionResult<PagedResult<ConversationDto>>> GetAll(
        [FromQuery] string? cursor,
        [FromQuery] int pageSize = 20,
        CancellationToken ct = default)
    {
        return Ok(await conversationService.GetPagedAsync(cursor, pageSize, ct));
    }
}

// ❌ Wrong: business logic in controller
[HttpPost("{id:guid}/messages")]
public async Task<IActionResult> SendMessage(Guid id, [FromBody] SendMessageRequest request)
{
    // BUG: Business logic in controller — cannot be reused from SignalR hub
    var user = await _userRepo.GetByIdAsync(User.GetUserId()); // Data access in controller
    if (user.IsBanned) return Forbid(); // Domain decision in controller
    if (request.Content.Length > 4000) return BadRequest("Too long"); // Validation that belongs in FluentValidation
    var message = new Message { Content = request.Content }; // Entity creation in controller
    await _messageRepo.AddAsync(message);
    await _unitOfWork.SaveChangesAsync();
    return Ok(message);
}

// ✅ Correct base controller for shared behavior
[ApiController]
public abstract class ApiControllerBase : ControllerBase
{
    // Shared behavior: correlation ID, common response helpers
    protected Guid CurrentUserId => User.GetUserId();
}
```

## The Trap

```csharp
// A senior developer writes a thin controller.
// Delegates everything. Ships.
// The trap: exception handling logic leaks into controllers.

[HttpPost("login")]
public async Task<IActionResult> Login([FromBody] LoginRequest request, CancellationToken ct)
{
    try
    {
        var result = await _authService.LoginAsync(request.Identifier, request.Password, ct);
        return Ok(result);
    }
    catch (AppException ex) when (ex.Code == "INVALID_CREDENTIALS")
    {
        return Unauthorized(new { error = ex.Message }); // Exception handling in controller
    }
    catch (AppException ex) when (ex.Code == "ACCOUNT_LOCKED")
    {
        return StatusCode(423, new { error = ex.Message, lockedUntil = ex.Data["lockedUntil"] });
    }
    catch (AppException ex)
    {
        return BadRequest(new { error = ex.Message }); // Duplicated in every controller
    }
}

// This pattern is duplicated in every controller method. Fix:
// Use a global exception handler — controllers have zero try-catch blocks.
// See global-exception-handler.md

[HttpPost("login")]
public async Task<IActionResult> LoginClean([FromBody] LoginRequest request, CancellationToken ct)
{
    // No try-catch — global handler converts AppException to appropriate HTTP response
    var result = await _authService.LoginAsync(request.Identifier, request.Password, ct);
    Response.Cookies.Append("access_token", result.AccessToken, _cookieOptions);
    return Ok(new { result.UserId, result.Username });
}
```

## The Exception
Simple CRUD controllers for admin/internal tools where the service layer would just be a pass-through wrapper add no value and increase ceremony. In these cases, calling the repository directly from the controller is acceptable — document the decision explicitly and enforce it is not a pattern for user-facing APIs. The rule is strict for any controller serving user traffic at scale.

## Before You Merge
- Does every controller method contain zero data access calls — no `_repository`, no `_context`?
- Does every controller method contain zero business logic — no `if (user.IsBanned)`, no domain decisions?
- Does every controller method have zero `try-catch` blocks — relying on global exception handler?
- Are all route parameters using type constraints (`:guid`, `:int`) — not raw string with manual parsing?
- Are `[ProducesResponseType]` attributes present for every possible response status code?
