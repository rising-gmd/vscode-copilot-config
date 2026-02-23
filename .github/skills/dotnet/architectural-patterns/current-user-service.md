# Current User Service
> Verified against: .NET 9 | C# 13 | ASP.NET Core 9.x
> Last reviewed: 2026-02-22

## The Law
Define `ICurrentUserService` in the Application layer with no HTTP or ASP.NET Core imports — the interface exposes user identity, not HTTP context.

## Why This Kills You At Scale
Application services that import `Microsoft.AspNetCore.Http` to call `IHttpContextAccessor.HttpContext.User` cannot be used in Hangfire background jobs, console tools, or worker services without a full ASP.NET Core pipeline. At 100k users sending 2 million messages per day, when you need to move message processing to a dedicated worker service for horizontal scale, you discover every service is tightly coupled to ASP.NET Core's request pipeline — a full rewrite of the service layer, not an infrastructure change.

## The Pattern

```csharp
#nullable enable
using System.Security.Claims;
using Microsoft.AspNetCore.Http;

// ✅ Correct: interface in Application layer — zero ASP.NET Core imports
// Application/Interfaces/ICurrentUserService.cs
public interface ICurrentUserService
{
    Guid GetUserId();
    string GetUsername();
    string GetEmail();
    string? GetIpAddress();
    bool IsAuthenticated();
    bool IsInRole(string role);
}

// ✅ Correct: HTTP implementation in API layer — ASP.NET Core imports contained here
// API/Services/HttpCurrentUserService.cs
public sealed class HttpCurrentUserService(
    IHttpContextAccessor httpContextAccessor)
    : ICurrentUserService
{
    private ClaimsPrincipal User =>
        httpContextAccessor.HttpContext?.User
        ?? throw new UnauthorizedException("No HTTP context available");

    public Guid GetUserId()
    {
        var value = User.FindFirstValue(JwtRegisteredClaimNames.Sub)
            ?? User.FindFirstValue(ClaimTypes.NameIdentifier)
            ?? throw new UnauthorizedException("User ID claim not present");

        return Guid.TryParse(value, out var id)
            ? id
            : throw new UnauthorizedException("User ID claim is not a valid GUID");
    }

    public string GetUsername()
        => User.FindFirstValue("username")
            ?? throw new UnauthorizedException("Username claim not present");

    public string GetEmail()
        => User.FindFirstValue(JwtRegisteredClaimNames.Email)
            ?? User.FindFirstValue(ClaimTypes.Email)
            ?? throw new UnauthorizedException("Email claim not present");

    public string? GetIpAddress()
        => httpContextAccessor.HttpContext?.Connection.RemoteIpAddress?.ToString();

    public bool IsAuthenticated()
        => httpContextAccessor.HttpContext?.User?.Identity?.IsAuthenticated == true;

    public bool IsInRole(string role)
        => User.IsInRole(role);
}

// ✅ Correct: System implementation for background jobs
// Infrastructure/Services/SystemCurrentUserService.cs
public sealed class SystemCurrentUserService : ICurrentUserService
{
    // Well-known Guid — must exist in Users table
    public static readonly Guid SystemUserId =
        new("00000000-0000-0000-0000-000000000001");

    public Guid GetUserId() => SystemUserId;
    public string GetUsername() => "system";
    public string GetEmail() => "system@internal.local";
    public string? GetIpAddress() => null;
    public bool IsAuthenticated() => true;
    public bool IsInRole(string role) => role is "System" or "Admin";
}

// ✅ Correct: test implementation — injects any user identity
public sealed class TestCurrentUserService(
    Guid userId,
    string username = "testuser",
    string email = "test@example.com",
    string? ipAddress = "127.0.0.1") : ICurrentUserService
{
    public Guid GetUserId() => userId;
    public string GetUsername() => username;
    public string GetEmail() => email;
    public string? GetIpAddress() => ipAddress;
    public bool IsAuthenticated() => true;
    public bool IsInRole(string role) => false;
}

// ✅ Correct: DI registration per context
// API Program.cs:
// builder.Services.AddHttpContextAccessor();
// builder.Services.AddScoped<ICurrentUserService, HttpCurrentUserService>();

// Hangfire worker:
// services.AddScoped<ICurrentUserService, SystemCurrentUserService>();

// Integration tests:
// services.AddScoped<ICurrentUserService>(_ =>
//     new TestCurrentUserService(userId: testUserId));

// ✅ Correct: application service — no knowledge of HTTP context
public sealed class MessageService(
    IMessageRepository repo,
    ICurrentUserService currentUser) // Not IHttpContextAccessor
{
    public async Task<MessageDto> GetByIdAsync(Guid id, CancellationToken ct)
    {
        var userId = currentUser.GetUserId(); // Works in HTTP, Hangfire, and tests
        var message = await repo.GetByIdAsync(id, ct)
            ?? throw new NotFoundException($"Message {id} not found");

        if (message.SenderId != userId)
            throw new ForbiddenException("Access to this message is not permitted");

        return message.ToDto();
    }
}

// ❌ Wrong: IHttpContextAccessor in Application layer
// Application/Services/MessageService.cs
using Microsoft.AspNetCore.Http; // ← ASP.NET Core in Application layer

public sealed class BrokenMessageService(IHttpContextAccessor accessor)
{
    public async Task<MessageDto> GetByIdAsync(Guid id, CancellationToken ct)
    {
        // Throws NullReferenceException in Hangfire — no HTTP context
        var userId = Guid.Parse(
            accessor.HttpContext!.User.FindFirstValue(ClaimTypes.NameIdentifier)!);
    }
}
```

## The Trap

```csharp
// A senior developer correctly defines ICurrentUserService in Application layer.
// HttpCurrentUserService in API layer. Works in all contexts. Ships.
// The trap: Scoped lifetime + Singleton consumer causes stale identity.

// Scenario: someone registers ICurrentUserService as Singleton (mistakenly).
// First request: User A logs in. GetUserId() returns User A's ID. Cached in singleton.
// Second request: User B is now the caller. GetUserId() still returns User A's ID.
// User B can read and modify User A's data. Silent data leak.

// Fix: ICurrentUserService MUST be Scoped — never Singleton, never Transient.
// Scoped: one instance per HTTP request. Correct.
// Singleton: one instance for app lifetime. Fatal security flaw.
// Transient: new instance per injection. Loses context on re-injection within same request.

builder.Services.AddScoped<ICurrentUserService, HttpCurrentUserService>(); // ✅ Scoped

// Validate this with a startup check:
builder.Services.AddOptions<ServiceLifetimeValidationOptions>()
    .ValidateOnStart();

// Or use architecture tests:
// typeof(HttpCurrentUserService) must be registered as Scoped
// If registered as Singleton, fail the test — do not let it reach production.

// ✅ Detect in development via ValidateScopes:
builder.Services.Configure<ServiceProviderOptions>(options =>
{
    options.ValidateScopes = builder.Environment.IsDevelopment();
    options.ValidateOnBuild = true;
});
// This throws at startup if a Scoped service is consumed by a Singleton.
```

## The Exception
Read-only access to configuration values (tenant ID, app ID) that are known at startup and do not change per-request can be provided via a Singleton `IApplicationContext` or `ITenantContext` — these are not user identity, they are app-level constants. Do not conflate "who is the current user" (per-request, Scoped) with "what is this application instance" (startup-time, Singleton). Keep the two concerns in separate interfaces.

## Before You Merge
- Is `ICurrentUserService` defined in Application layer with zero `Microsoft.AspNetCore` imports?
- Is `HttpCurrentUserService` registered as `Scoped` — not `Singleton` or `Transient`?
- Is `ValidateScopes = true` enabled in development — catching Scoped-in-Singleton violations at startup?
- Do Hangfire workers and background jobs use `SystemCurrentUserService` — not `HttpCurrentUserService`?
- Do unit and integration tests use `TestCurrentUserService` with explicit user identities — not mocking `IHttpContextAccessor`?
