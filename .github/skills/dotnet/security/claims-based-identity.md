# Claims-Based Identity
> Verified against: .NET 9 | C# 13 | Microsoft.AspNetCore.Authentication.JwtBearer 9.x
> Last reviewed: 2026-02-22

## The Law
Extract user identity from claims using a centralized `ICurrentUserService` — never access `HttpContext.User` directly in application layer services or domain logic.

## Why This Kills You At Scale
Scattering `HttpContext.User.FindFirst(ClaimTypes.NameIdentifier)` across services creates untestable code — you cannot unit test any service that touches HttpContext without a full integration test setup. At 100k users with complex permission requirements, untestable authorization logic means permission bugs reach production undetected and affect real users before tests catch them.

## The Pattern

```csharp
#nullable enable
using System.Security.Claims;
using Microsoft.AspNetCore.Http;

// ✅ Correct: interface in Application layer — no HttpContext dependency
public interface ICurrentUserService
{
    Guid GetUserId();
    string GetUsername();
    string GetEmail();
    string? GetIpAddress();
    bool IsAuthenticated();
    bool IsInRole(string role);
}

// ✅ Correct: implementation in API layer — knows about HttpContext
public sealed class CurrentUserService(IHttpContextAccessor httpContextAccessor) : ICurrentUserService
{
    private ClaimsPrincipal? User => httpContextAccessor.HttpContext?.User;

    public Guid GetUserId()
    {
        var value = User?.FindFirstValue(JwtRegisteredClaimNames.Sub)
            ?? User?.FindFirstValue(ClaimTypes.NameIdentifier)
            ?? throw new UnauthorizedException("User ID claim not found");

        return Guid.TryParse(value, out var id)
            ? id
            : throw new UnauthorizedException("User ID claim is not a valid Guid");
    }

    public string GetUsername()
        => User?.FindFirstValue("username")
            ?? throw new UnauthorizedException("Username claim not found");

    public string GetEmail()
        => User?.FindFirstValue(JwtRegisteredClaimNames.Email)
            ?? User?.FindFirstValue(ClaimTypes.Email)
            ?? throw new UnauthorizedException("Email claim not found");

    public string? GetIpAddress()
        => httpContextAccessor.HttpContext?.Connection.RemoteIpAddress?.ToString();

    public bool IsAuthenticated()
        => User?.Identity?.IsAuthenticated == true;

    public bool IsInRole(string role)
        => User?.IsInRole(role) == true;
}

// ✅ Correct: register with scoped lifetime — one per request
// builder.Services.AddHttpContextAccessor();
// builder.Services.AddScoped<ICurrentUserService, CurrentUserService>();

// ✅ Correct: use in application service — fully unit testable
public sealed class ConversationService(
    IConversationRepository repo,
    ICurrentUserService currentUser)
{
    public async Task<ConversationDto> GetByIdAsync(Guid conversationId, CancellationToken ct)
    {
        var userId = currentUser.GetUserId(); // No HttpContext here
        var conversation = await repo.GetByIdForUserAsync(conversationId, userId, ct)
            ?? throw new NotFoundException("Conversation not found");
        return conversation.ToDto();
    }
}

// ✅ Correct: unit test — mock ICurrentUserService, no TestServer needed
// var mockCurrentUser = new Mock<ICurrentUserService>();
// mockCurrentUser.Setup(s => s.GetUserId()).Returns(testUserId);
// var service = new ConversationService(mockRepo.Object, mockCurrentUser.Object);

// ✅ Correct: extension methods for clean claim extraction
public static class ClaimsPrincipalExtensions
{
    public static Guid GetUserId(this ClaimsPrincipal principal)
    {
        var value = principal.FindFirstValue(JwtRegisteredClaimNames.Sub)
            ?? principal.FindFirstValue(ClaimTypes.NameIdentifier)
            ?? throw new UnauthorizedException("Sub claim missing");

        return Guid.TryParse(value, out var id)
            ? id
            : throw new UnauthorizedException("Sub claim is not a Guid");
    }
}

// ❌ Wrong: HttpContext in application service — untestable
public class VulnerableService(IHttpContextAccessor accessor)
{
    public async Task DoSomethingAsync(CancellationToken ct)
    {
        // Now this service requires a real HTTP context to unit test
        var userId = accessor.HttpContext!.User.FindFirstValue(ClaimTypes.NameIdentifier);
    }
}
```

## The Trap

```csharp
// A senior developer correctly creates ICurrentUserService.
// All services use it. Tests pass. Ships.
// The trap: a background job or Hangfire worker calls the same service.

// Background jobs run outside an HTTP context — IHttpContextAccessor.HttpContext is null.
// GetUserId() throws NullReferenceException inside a background job.
// The job fails silently (Hangfire catches and retries) or crashes the worker.

// The fix: background jobs must pass the actor's userId explicitly, not via ICurrentUserService

// ❌ Wrong: background job using ICurrentUserService
public class MessageCleanupJob(ConversationService conversationService)
{
    public async Task ExecuteAsync(CancellationToken ct)
    {
        // HttpContext is null in Hangfire — GetUserId() throws
        await conversationService.CleanupOldConversationsAsync(ct);
    }
}

// ✅ Correct: background jobs use a system identity or explicit userId parameter
public interface ICurrentUserService
{
    Guid GetUserId();
    bool IsSystemContext(); // Returns true when running as system/background
}

public sealed class SystemUserService : ICurrentUserService
{
    // Well-known system user ID — exists in DB, owns system operations
    public static readonly Guid SystemUserId = new("00000000-0000-0000-0000-000000000001");

    public Guid GetUserId() => SystemUserId;
    public bool IsSystemContext() => true;
    public string GetUsername() => "system";
    public string GetEmail() => "system@internal";
    public string? GetIpAddress() => null;
    public bool IsAuthenticated() => true;
    public bool IsInRole(string role) => role == "System";
}

// Register SystemUserService for Hangfire job scope:
// services.AddScoped<ICurrentUserService>(sp =>
//     isHangfireContext ? new SystemUserService() : new CurrentUserService(sp.GetRequired...));
```

## The Exception
Controllers can access `User` claims directly for simple cases — `User.GetUserId()` via extension method in a controller action is clean and readable. The rule against direct HttpContext access applies to application services and domain logic — not controllers, which are already in the API layer and are integration-tested by nature.

## Before You Merge
- Is `ICurrentUserService` defined in the Application layer with no reference to `HttpContext` or `IHttpContextAccessor`?
- Are all application services injecting `ICurrentUserService` — not `IHttpContextAccessor`?
- Do background jobs and Hangfire workers use a `SystemUserService` or explicit userId parameter — not `ICurrentUserService` tied to HTTP context?
- Is `AddHttpContextAccessor()` registered in DI before `ICurrentUserService`?
- Can every service that calls `GetUserId()` be unit tested without a running HTTP server?
