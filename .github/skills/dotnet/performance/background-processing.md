# Background Processing
> Verified against: .NET 9 | C# 13 | Hangfire 1.8.x | Microsoft.Extensions.Hosting 9.x
> Last reviewed: 2026-02-22

## The Law
Move every operation that does not need to complete before returning an HTTP response into a background job — and use a durable job system (Hangfire, Azure Service Bus) not fire-and-forget Tasks, so work survives pod restarts.

## Why This Kills You At Scale
At one billion users, "send a welcome email" runs 1,000 times per second at peak registration. If that email send is synchronous in the registration endpoint, 1,000 concurrent SMTP connections per second are held open, SMTP server throttling causes timeouts, registration p99 latency balloons from 50ms to 8 seconds, and users abandon the flow. Move it to Hangfire: the registration endpoint completes in 5ms, the email enqueues in 2ms, and SMTP sends at a controlled rate. The user is registered and happy. The email arrives within seconds. No blocked threads, no throttling cascade.

## The Pattern

```csharp
#nullable enable
using Hangfire;
using Hangfire.SqlServer;
using Microsoft.Extensions.Hosting;

// ✅ Correct: Hangfire with SQL Server storage — durable, survives pod crashes
builder.Services.AddHangfire(config =>
    config
        .SetDataCompatibilityLevel(CompatibilityLevel.Version_180)
        .UseSimpleAssemblyNameTypeSerializer()
        .UseRecommendedSerializerSettings()
        .UseSqlServerStorage(
            builder.Configuration.GetConnectionString("Hangfire"),
            new SqlServerStorageOptions
            {
                CommandBatchMaxTimeout    = TimeSpan.FromMinutes(5),
                SlidingInvisibilityTimeout = TimeSpan.FromMinutes(5),
                QueuePollInterval         = TimeSpan.Zero, // Signal-based — no polling
                UseRecommendedIsolationLevel = true,
                DisableGlobalLocks        = true, // Required for multi-pod deployments
            }));

// ✅ Multiple queues — critical jobs never wait behind bulk email
builder.Services.AddHangfireServer(options =>
{
    options.Queues = ["critical", "default", "bulk", "maintenance"];
    options.WorkerCount = Environment.ProcessorCount * 2; // 2 workers per CPU core
});

// ✅ Correct: background job dispatcher abstraction — Application layer stays clean
public interface IBackgroundJobDispatcher
{
    void EnqueueWelcomeEmail(Guid userId);
    void EnqueuePasswordResetEmail(Guid userId, string token);
    void EnqueueMessageNotification(Guid messageId, IReadOnlyList<Guid> recipientIds);
    void ScheduleAccountDeletion(Guid userId, TimeSpan delay);
    void EnqueueBulkNotification(IReadOnlyList<Guid> userIds, string templateId);
}

public sealed class HangfireJobDispatcher : IBackgroundJobDispatcher
{
    public void EnqueueWelcomeEmail(Guid userId)
        => BackgroundJob.Enqueue<IEmailJobHandler>(
            queue: "default",
            job => job.SendWelcomeEmailAsync(userId, CancellationToken.None));

    public void EnqueuePasswordResetEmail(Guid userId, string token)
        // ✅ Critical queue — password reset must not wait behind bulk email
        => BackgroundJob.Enqueue<IEmailJobHandler>(
            queue: "critical",
            job => job.SendPasswordResetAsync(userId, token, CancellationToken.None));

    public void EnqueueMessageNotification(Guid messageId, IReadOnlyList<Guid> recipientIds)
        => BackgroundJob.Enqueue<INotificationJobHandler>(
            queue: "default",
            job => job.SendMessageNotificationAsync(messageId, recipientIds, CancellationToken.None));

    public void ScheduleAccountDeletion(Guid userId, TimeSpan delay)
        // ✅ Delayed job — runs 30 days after cancellation request (GDPR workflow)
        => BackgroundJob.Schedule<IAccountJobHandler>(
            queue: "maintenance",
            job => job.DeleteAccountAsync(userId, CancellationToken.None),
            delay);

    public void EnqueueBulkNotification(IReadOnlyList<Guid> userIds, string templateId)
        // ✅ Bulk queue — processed with lowest priority, never starves critical/default
        => BackgroundJob.Enqueue<INotificationJobHandler>(
            queue: "bulk",
            job => job.SendBulkNotificationAsync(userIds, templateId, CancellationToken.None));
}

// ✅ Correct: idempotent job handler — safe to retry on transient failure
public sealed class EmailJobHandler(
    IUserRepository userRepo,
    IEmailService emailService,
    IUnitOfWork unitOfWork,
    ILogger<EmailJobHandler> logger) : IEmailJobHandler
{
    [AutomaticRetry(Attempts = 3, DelaysInSeconds = [30, 300, 3600])]
    public async Task SendWelcomeEmailAsync(Guid userId, CancellationToken ct)
    {
        var user = await userRepo.GetByIdAsync(userId, ct);
        if (user is null)
        {
            // ✅ User deleted between enqueue and execution — this is expected, not an error
            logger.LogWarning(
                "Skipping welcome email for deleted user {UserId}", userId);
            return; // Do not throw — throwing causes Hangfire to retry forever
        }

        if (user.WelcomeEmailSentAt.HasValue)
        {
            // ✅ Idempotency check — job was already processed (duplicate enqueue or retry after partial success)
            logger.LogDebug("Welcome email already sent to {UserId}", userId);
            return;
        }

        await emailService.SendWelcomeAsync(user.Email, user.Username, ct);

        // ✅ Mark as sent — prevents duplicate on retry
        user.WelcomeEmailSentAt = DateTime.UtcNow;
        await unitOfWork.SaveChangesAsync(ct);
    }
}

// ✅ Correct: IHostedService for continuous background work (not one-off jobs)
public sealed class MessageSyncWorker(
    IServiceScopeFactory scopeFactory,
    ILogger<MessageSyncWorker> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        logger.LogInformation("MessageSyncWorker started");

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                // ✅ Create scope per iteration — services are Scoped, worker is Singleton
                using var scope = scopeFactory.CreateScope();
                var service = scope.ServiceProvider
                    .GetRequiredService<IMessageSyncService>();

                await service.ProcessPendingAsync(stoppingToken);
            }
            catch (Exception ex) when (!stoppingToken.IsCancellationRequested)
            {
                logger.LogError(ex, "MessageSyncWorker iteration failed — continuing");
                await Task.Delay(TimeSpan.FromSeconds(30), stoppingToken);
            }

            await Task.Delay(TimeSpan.FromSeconds(10), stoppingToken);
        }
    }
}

// ❌ Wrong: fire-and-forget Task — not durable, not monitored
public async Task<IActionResult> Register(RegisterRequest request, CancellationToken ct)
{
    var user = await _userService.CreateAsync(request, ct);

    // BUG: if the pod crashes after return but before the task completes,
    // the welcome email is never sent. No retry. No visibility. No alert.
    _ = _emailService.SendWelcomeAsync(user.Email, user.Username, CancellationToken.None);

    return Created(...);
}
```

## The Trap

```csharp
// A senior developer correctly uses Hangfire with durable SQL storage.
// Jobs survive pod restarts. Retry with backoff. Ships.
// The trap: Hangfire job handlers injecting Scoped services directly.

// Hangfire resolves job handler instances through DI.
// Hangfire's built-in DI scope is per-job-execution — correct.
// But if a job handler is registered as Singleton and injects a Scoped service,
// the Scoped service is resolved ONCE at Singleton registration time
// and reused forever — same DbContext, same ICurrentUserService across all jobs.
// This causes concurrency exceptions from EF Core (DbContext is not thread-safe)
// and identity bleed (SystemUserService gets replaced with a user-scoped instance).

// Fix: NEVER inject Scoped services into Hangfire job handlers that are Singleton.
// Hangfire job handlers should be registered as Transient:
builder.Services.AddTransient<IEmailJobHandler, EmailJobHandler>();
builder.Services.AddTransient<INotificationJobHandler, NotificationJobHandler>();

// OR: inject IServiceScopeFactory and resolve Scoped dependencies inside the method:
public sealed class NotificationJobHandler(IServiceScopeFactory scopeFactory)
    : INotificationJobHandler
{
    public async Task SendMessageNotificationAsync(
        Guid messageId,
        IReadOnlyList<Guid> recipientIds,
        CancellationToken ct)
    {
        // ✅ Fresh scope per job execution — Scoped dependencies resolved fresh
        using var scope = scopeFactory.CreateScope();
        var repo    = scope.ServiceProvider.GetRequiredService<IMessageRepository>();
        var emailSvc = scope.ServiceProvider.GetRequiredService<IEmailService>();

        var message = await repo.GetByIdAsync(messageId, ct);
        if (message is null) return;

        foreach (var recipientId in recipientIds)
            await emailSvc.SendMessageNotificationAsync(recipientId, message, ct);
    }
}
```

## The Exception
Very low-volume, non-critical background operations (nightly report generation, weekly digest emails, manual admin triggers) can use `IHostedService` with a simple timer loop instead of Hangfire — the infrastructure overhead of a durable job system is not justified for tasks that run once per day and losing one execution is acceptable. Use Hangfire for: user-triggered operations (emails, notifications), anything that must survive pod restarts, anything that requires retry, and anything at volume. Use `IHostedService` for: internal maintenance loops, health reporters, connection warm-up.

## Before You Merge
- Are Hangfire job handlers registered as `Transient` — never `Singleton` or `Scoped`?
- Does every job handler check idempotency before performing the operation — so retries are safe?
- Are queues (`critical`, `default`, `bulk`) defined explicitly — so password resets never queue behind bulk email?
- Does every job handler gracefully handle the case where the target entity no longer exists — returning without throwing?
- Is `DisableGlobalLocks = true` set in Hangfire SQL Server options — required for multi-pod deployments to prevent distributed lock contention?
