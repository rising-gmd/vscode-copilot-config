# Resource-Based Authorization
> Verified against: .NET 9 | C# 13 | Microsoft.AspNetCore.Authorization 9.x
> Last reviewed: 2026-02-22

## The Law
Check ownership of the specific resource being accessed — not just that the user is authenticated — before returning or mutating any data.

## Why This Kills You At Scale
An authenticated user who knows another user's conversation ID calls `GET /api/conversations/[guid]` and reads private messages — because the endpoint checks `[Authorize]` (authenticated) but not ownership. This is IDOR (Insecure Direct Object Reference) — the most common API vulnerability in production systems. At 100k users, even a single IDOR on a message endpoint is a critical data breach affecting every user whose ID is guessable or enumerable.

## The Pattern

```csharp
#nullable enable
using Microsoft.AspNetCore.Authorization;

// ✅ Correct: define a requirement
public sealed class ConversationMemberRequirement : IAuthorizationRequirement { }

// ✅ Correct: handler fetches the resource and checks ownership
public sealed class ConversationMemberHandler(
    IConversationRepository conversationRepository)
    : AuthorizationHandler<ConversationMemberRequirement, Guid>
{
    protected override async Task HandleRequirementAsync(
        AuthorizationHandlerContext context,
        ConversationMemberRequirement requirement,
        Guid conversationId)
    {
        var userId = context.User.GetUserId();

        var isMember = await conversationRepository.IsUserMemberAsync(conversationId, userId);

        if (isMember)
            context.Succeed(requirement);
        // Do NOT call context.Fail() — allows other handlers to succeed if registered
    }
}

// ✅ Correct: register in DI
// builder.Services.AddScoped<IAuthorizationHandler, ConversationMemberHandler>();
// builder.Services.AddAuthorization(options =>
// {
//     options.AddPolicy("ConversationMember",
//         p => p.Requirements.Add(new ConversationMemberRequirement()));
// });

// ✅ Correct: controller uses resource-based check
[HttpGet("{conversationId:guid}")]
public async Task<IActionResult> GetConversation(
    Guid conversationId,
    [FromServices] IAuthorizationService authorizationService,
    CancellationToken ct)
{
    // Check ownership BEFORE loading the full resource
    // Do not load then check — that leaks data via timing side channel
    var authResult = await authorizationService.AuthorizeAsync(
        User,
        conversationId,
        "ConversationMember");

    if (!authResult.Succeeded)
        // Return 404 not 403 — do not confirm the resource exists to unauthorized users
        return NotFound();

    var conversation = await _conversationService.GetByIdAsync(conversationId, ct);
    return Ok(conversation);
}

// ✅ Correct: message-level ownership
[HttpDelete("{messageId:guid}")]
public async Task<IActionResult> DeleteMessage(
    Guid messageId,
    [FromServices] IAuthorizationService authorizationService,
    CancellationToken ct)
{
    var authResult = await authorizationService.AuthorizeAsync(
        User, messageId, "MessageOwner");

    if (!authResult.Succeeded)
        return NotFound(); // 404 not 403 — don't leak existence

    await _messageService.DeleteAsync(messageId, ct);
    return NoContent();
}

// ❌ Wrong: checking authentication only — IDOR vulnerability
[HttpGet("{conversationId:guid}")]
[Authorize] // Only checks "is user logged in" — not "does user own this"
public async Task<IActionResult> GetConversationInsecure(Guid conversationId, CancellationToken ct)
{
    var conversation = await _conversationService.GetByIdAsync(conversationId, ct);
    return conversation is null ? NotFound() : Ok(conversation); // Any user can read any conversation
}
```

## The Trap

```csharp
// A senior developer correctly implements resource-based auth.
// It works. Passes penetration test. Ships.
// Six months later, a new developer adds a "bulk" endpoint.

[HttpPost("conversations/bulk")]
[Authorize]
public async Task<IActionResult> GetBulkConversations(
    [FromBody] List<Guid> conversationIds,
    CancellationToken ct)
{
    // BUG: Checks auth on the endpoint, not on each resource
    // User sends [theirConversationId, victimConversationId1, victimConversationId2]
    // All three are returned — IDOR at bulk scale
    var conversations = await _repo.GetByIdsAsync(conversationIds, ct);
    return Ok(conversations);
}

// Fix: filter results to only conversations the requesting user is a member of
[HttpPost("conversations/bulk")]
[Authorize]
public async Task<IActionResult> GetBulkConversationsSecure(
    [FromBody] List<Guid> conversationIds,
    CancellationToken ct)
{
    var userId = User.GetUserId();
    // Repository enforces ownership at DB level — user can only ever get their own
    var conversations = await _repo.GetByIdsForUserAsync(conversationIds, userId, ct);
    return Ok(conversations);
}

// The pattern: for bulk endpoints, ALWAYS scope the DB query to the current user.
// Never fetch all then filter in application code — that still loads unauthorized data.
```

## The Exception
Admin endpoints accessed only by users with the Admin role can bypass resource-level ownership checks — an admin reading any conversation for moderation is legitimate. Implement this as an explicit policy: `"ConversationMember OR Admin"` — not by removing the check. Log every admin access to a resource they do not own for audit purposes.

## Before You Merge
- Does every `GET/PUT/PATCH/DELETE` endpoint that takes a resource ID check ownership — not just authentication?
- Do unauthorized resource access attempts return `404` — not `403` — to avoid confirming resource existence?
- Do bulk endpoints scope their DB query to the current user's owned resources at the SQL level?
- Is there an `IAuthorizationHandler` registered for every new resource type added?
- Are admin bypasses logged to an audit trail with userId, resourceId, and timestamp?
