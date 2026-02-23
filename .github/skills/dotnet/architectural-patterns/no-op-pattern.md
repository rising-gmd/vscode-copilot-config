# No-Op Pattern
> Verified against: .NET 9 | C# 13
> Last reviewed: 2026-02-22

## The Law
Provide a No-Op implementation for every optional or infrastructural dependency — never use null for optional services, and never let a missing dependency prevent unit tests from running.

## Why This Kills You At Scale
A service that accepts `IBackgroundJobDispatcher? backgroundJobDispatcher = null` and then calls `_backgroundJobDispatcher?.EnqueueVerificationEmail(...)` peppers the codebase with null-conditional operators on a dependency that should always exist in production. At 100k users, if the DI container fails to resolve the dispatcher in one environment (staging misconfiguration), the null-conditional silently skips all background jobs — no errors, no alerts, emails never sent. The null contract hides a real failure.

## The Pattern

```csharp
#nullable enable

// ✅ Correct: the interface — clean contract, no nullable sprawl
public interface IBackgroundJobDispatcher
{
    void EnqueueVerificationEmail(string email, string username, string token);
    void EnqueuePasswordResetEmail(string email, string username, string token);
    void EnqueueWelcomeEmail(string email, string username);
}

// ✅ Correct: real implementation — Hangfire, Azure Service Bus, etc.
public sealed class HangfireJobDispatcher : IBackgroundJobDispatcher
{
    public void EnqueueVerificationEmail(string email, string username, string token)
        => BackgroundJob.Enqueue<IEmailService>(
            s => s.SendVerificationEmailAsync(email, username, token, default));

    public void EnqueuePasswordResetEmail(string email, string username, string token)
        => BackgroundJob.Enqueue<IEmailService>(
            s => s.SendPasswordResetEmailAsync(email, username, token, default));

    public void EnqueueWelcomeEmail(string email, string username)
        => BackgroundJob.Enqueue<IEmailService>(
            s => s.SendWelcomeEmailAsync(email, username, default));
}

// ✅ Correct: No-Op implementation — does nothing, logs a warning so it is not invisible
public sealed class NoOpBackgroundJobDispatcher(
    ILogger<NoOpBackgroundJobDispatcher>? logger = null)
    : IBackgroundJobDispatcher
{
    public void EnqueueVerificationEmail(string email, string username, string token)
        => logger?.LogWarning(
            "NoOp: EnqueueVerificationEmail called for {Email} — no dispatcher configured",
            email);

    public void EnqueuePasswordResetEmail(string email, string username, string token)
        => logger?.LogWarning(
            "NoOp: EnqueuePasswordResetEmail called for {Email} — no dispatcher configured",
            email);

    public void EnqueueWelcomeEmail(string email, string username)
        => logger?.LogWarning(
            "NoOp: EnqueueWelcomeEmail called for {Username} — no dispatcher configured",
            username);
}

// ✅ Correct: DI registration — explicit per environment
// Production:
// builder.Services.AddScoped<IBackgroundJobDispatcher, HangfireJobDispatcher>();

// Integration tests:
// services.AddScoped<IBackgroundJobDispatcher, NoOpBackgroundJobDispatcher>();

// ✅ Correct: service consumes the interface — never nullable
public sealed class AuthService(
    IUserRepository userRepository,
    IUnitOfWork unitOfWork,
    IBackgroundJobDispatcher backgroundJobDispatcher) // Never nullable — always resolved
{
    public async Task RegisterAsync(RegisterRequest request, CancellationToken ct)
    {
        var user = User.Create(request.Email, request.Username);
        await userRepository.AddAsync(user, ct);
        await unitOfWork.SaveChangesAsync(ct);

        // No null check needed — always safe to call
        backgroundJobDispatcher.EnqueueVerificationEmail(
            user.Email,
            user.Username,
            user.EmailVerificationToken!);
    }
}

// ✅ Correct: No-Op for IRealTimeNotifier — tests don't need SignalR
public sealed class NoOpRealTimeNotifier : IRealTimeNotifier
{
    public Task NotifyMessageSentAsync(Guid conversationId, MessageDto message, CancellationToken ct = default)
        => Task.CompletedTask;

    public Task NotifyConversationCreatedAsync(Guid userId, ConversationDto conversation, CancellationToken ct = default)
        => Task.CompletedTask;

    public Task NotifyMessageReadAsync(Guid conversationId, Guid messageId, Guid readByUserId, CancellationToken ct = default)
        => Task.CompletedTask;

    public Task NotifyUserPresenceChangedAsync(Guid userId, bool isOnline, CancellationToken ct = default)
        => Task.CompletedTask;
}

// ✅ Correct: No-Op for email in integration tests — prevents real emails
public sealed class NoOpEmailService : IEmailService
{
    public Task SendVerificationEmailAsync(string to, string username, string token, CancellationToken ct)
        => Task.CompletedTask;

    public Task SendPasswordResetEmailAsync(string to, string username, string token, CancellationToken ct)
        => Task.CompletedTask;

    public Task SendWelcomeEmailAsync(string to, string username, CancellationToken ct)
        => Task.CompletedTask;
}

// ❌ Wrong: nullable dependency with null-conditional — hides failures
public sealed class AuthServiceBroken(
    IBackgroundJobDispatcher? backgroundJobDispatcher = null)
{
    public async Task RegisterAsync(RegisterRequest request, CancellationToken ct)
    {
        // Silent failure — if dispatcher is not configured, emails are never sent
        // No log, no error, no alert. Just silence.
        _backgroundJobDispatcher?.EnqueueVerificationEmail(
            request.Email, request.Username, "token");
    }
}
```

## The Trap

```csharp
// A senior developer correctly provides No-Op implementations for all optional services.
// Tests use No-Ops. Production uses real implementations. Ships.
// The trap: No-Op implementations registered in production due to wrong environment check.

// In Program.cs:
if (builder.Environment.IsDevelopment())
{
    builder.Services.AddScoped<IEmailService, SmtpEmailService>();
}
else
{
    // BUG: Intended to register SendGridEmailService in production,
    // but developer accidentally registered NoOpEmailService.
    // All production emails silently go nowhere.
    // Password resets fail silently. Users think the feature is broken.
    // Discovered 3 days later when support tickets spike.
    builder.Services.AddScoped<IEmailService, NoOpEmailService>(); // Wrong
}

// Fix: make No-Op the OBVIOUS choice — name it unmistakably
// NoOpEmailService, not FakeEmailService or MockEmailService.
// In production registrations, never reference No-Op by accident.
// Use a startup validation that throws if No-Op is registered in production:

public sealed class NoOpEmailService : IEmailService
{
    // ✅ Throw if somehow registered in production — fail loud, fail fast
    public Task SendVerificationEmailAsync(string to, string username, string token, CancellationToken ct)
    {
        var env = Environment.GetEnvironmentVariable("ASPNETCORE_ENVIRONMENT");
        if (env == "Production")
            throw new InvalidOperationException(
                "NoOpEmailService is registered in Production — check DI configuration");

        return Task.CompletedTask;
    }
    // ... other methods same
}
```

## The Exception
Monitoring and telemetry sinks (Application Insights, OpenTelemetry exporters) are legitimate optional dependencies that default to null in development — the framework handles the null case gracefully via its own null-object implementation. Do not create No-Op wrappers for framework-managed telemetry. Create No-Ops only for your own application interfaces where the absence of the implementation would cause silent business failures.

## Before You Merge
- Is every `IBackgroundJobDispatcher`, `IEmailService`, and `IRealTimeNotifier` registered as a concrete type in every environment — never as null?
- Does each No-Op implementation log a warning when called — making misconfigured environments visible in logs?
- Does the No-Op implementation for `IEmailService` throw in production — failing loud if accidentally registered?
- Are unit and integration test projects registering No-Op implementations — not mocking the interface with Moq?
- Is every optional constructor parameter an interface with a No-Op fallback — no nullable interface parameters?
