# DateTime Provider
> Verified against: .NET 9 | C# 13
> Last reviewed: 2026-02-22

## The Law
Never call `DateTime.UtcNow` or `DateTimeOffset.UtcNow` directly in application or domain logic — always inject `IDateTimeProvider` so time can be controlled in tests.

## Why This Kills You At Scale
An account lockout that expires "15 minutes after the last failed attempt" tested with `DateTime.UtcNow` baked in cannot be unit tested without waiting 15 real minutes — so it is never properly tested. At 100k users, an untested lockout expiry edge case silently locks users out permanently, or unlocks them early, depending on the bug. The same applies to token expiry, scheduled job timing, audit timestamps, and rate limit windows. Every time-dependent business rule is a test-coverage gap when `DateTime.UtcNow` is called directly.

## The Pattern

```csharp
#nullable enable

// ✅ Correct: interface in Application or SharedKernel layer
public interface IDateTimeProvider
{
    DateTime UtcNow { get; }
    DateTimeOffset UtcNowOffset { get; }
    DateTime Today { get; }
}

// ✅ Correct: real implementation — delegates to system clock
public sealed class SystemDateTimeProvider : IDateTimeProvider
{
    public DateTime UtcNow => DateTime.UtcNow;
    public DateTimeOffset UtcNowOffset => DateTimeOffset.UtcNow;
    public DateTime Today => DateTime.UtcNow.Date;
}

// ✅ Correct: test implementation — fully controllable
public sealed class FakeDateTimeProvider(DateTime initialTime) : IDateTimeProvider
{
    private DateTime _current = initialTime;

    public DateTime UtcNow => _current;
    public DateTimeOffset UtcNowOffset => new(_current, TimeSpan.Zero);
    public DateTime Today => _current.Date;

    // Advance time in tests without Thread.Sleep
    public void Advance(TimeSpan by) => _current = _current.Add(by);
    public void SetTo(DateTime time) => _current = time;
}

// ✅ Correct: DI registration
// builder.Services.AddSingleton<IDateTimeProvider, SystemDateTimeProvider>();

// ✅ Correct: usage in domain logic — all time from the provider
public sealed class AccountLockoutService(IDateTimeProvider dateTime)
{
    private const int MaxAttempts = 5;
    private static readonly TimeSpan LockoutDuration = TimeSpan.FromMinutes(15);

    public void ValidateLockoutState(User user)
    {
        // ✅ All time comparisons use injected provider
        if (user.IsLocked
            && user.LockedUntil.HasValue
            && user.LockedUntil <= dateTime.UtcNow) // Not DateTime.UtcNow
        {
            user.IsLocked = false;
            user.LockedUntil = null;
            user.FailedLoginAttempts = 0;
        }
        else if (user.IsLocked)
        {
            throw new AppException("ACCOUNT_LOCKED", "Account is locked")
                .WithMetadata("lockedUntil", user.LockedUntil!);
        }
    }

    public async Task HandleFailedLoginAsync(User user, CancellationToken ct)
    {
        user.FailedLoginAttempts++;
        user.LastFailedLoginAttempt = dateTime.UtcNow; // Not DateTime.UtcNow

        if (user.FailedLoginAttempts >= MaxAttempts)
        {
            user.IsLocked = true;
            user.LockedUntil = dateTime.UtcNow.Add(LockoutDuration); // Not DateTime.UtcNow
        }
    }
}

// ✅ Correct: unit test — full time control without Thread.Sleep
public sealed class AccountLockoutServiceTests
{
    [Fact]
    public void ValidateLockoutState_AutoUnlocks_WhenLockoutExpired()
    {
        var fakeTime = new FakeDateTimeProvider(new DateTime(2026, 1, 1, 12, 0, 0));
        var service = new AccountLockoutService(fakeTime);

        var user = new User
        {
            IsLocked = true,
            LockedUntil = fakeTime.UtcNow.AddMinutes(-1), // Expired 1 minute ago
            FailedLoginAttempts = 5
        };

        service.ValidateLockoutState(user);

        Assert.False(user.IsLocked);
        Assert.Null(user.LockedUntil);
        Assert.Equal(0, user.FailedLoginAttempts);
    }

    [Fact]
    public void ValidateLockoutState_Throws_WhenLockoutActive()
    {
        var fakeTime = new FakeDateTimeProvider(new DateTime(2026, 1, 1, 12, 0, 0));
        var service = new AccountLockoutService(fakeTime);

        var user = new User
        {
            IsLocked = true,
            LockedUntil = fakeTime.UtcNow.AddMinutes(10) // Still locked
        };

        Assert.Throws<AppException>(() => service.ValidateLockoutState(user));
    }

    [Fact]
    public void HandleFailedLogin_LockAccount_AfterMaxAttempts()
    {
        var fakeTime = new FakeDateTimeProvider(DateTime.UtcNow);
        var service = new AccountLockoutService(fakeTime);
        var user = new User { FailedLoginAttempts = 4 }; // One before max

        service.HandleFailedLoginAsync(user, default).Wait();

        Assert.True(user.IsLocked);
        // Verify lockout is exactly 15 minutes from "now"
        Assert.Equal(fakeTime.UtcNow.AddMinutes(15), user.LockedUntil);
    }
}

// ❌ Wrong: DateTime.UtcNow directly — time travel impossible in tests
public sealed class UntestableLockoutService
{
    public void Lock(User user)
    {
        user.IsLocked = true;
        user.LockedUntil = DateTime.UtcNow.AddMinutes(15); // Baked in — no test control
    }
}
```

## The Trap

```csharp
// A senior developer correctly injects IDateTimeProvider everywhere.
// All tests use FakeDateTimeProvider. Ships.
// The trap: Singleton scope mismatch destroys time consistency.

// IDateTimeProvider registered as Singleton — correct.
// But FakeDateTimeProvider in integration tests is registered as Singleton too.
// Multiple tests share the same FakeDateTimeProvider instance.
// Test A advances time by 1 hour. Test B runs next, time is already 1 hour ahead.
// Tests become order-dependent — fail randomly based on execution order.
// Impossible to diagnose without understanding the shared state.

// Fix: in test projects, always register FakeDateTimeProvider as Transient
// OR create a new instance per test class constructor

public class AuthServiceTests : IDisposable
{
    private readonly FakeDateTimeProvider _fakeTime;
    private readonly AuthService _sut;

    public AuthServiceTests()
    {
        // Fresh FakeDateTimeProvider for EVERY test class instance
        _fakeTime = new FakeDateTimeProvider(new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc));

        var services = new ServiceCollection();
        services.AddSingleton<IDateTimeProvider>(_fakeTime); // This instance, not a shared one
        // ... other registrations

        var sp = services.BuildServiceProvider();
        _sut = sp.GetRequiredService<AuthService>();
    }

    public void Dispose() { /* cleanup */ }
}

// In WebApplicationFactory for integration tests:
factory.WithWebHostBuilder(builder =>
{
    builder.ConfigureServices(services =>
    {
        services.RemoveAll<IDateTimeProvider>();
        // Each test factory gets its own fresh instance
        services.AddSingleton<IDateTimeProvider>(new FakeDateTimeProvider(DateTime.UtcNow));
    });
});
```

## The Exception
Infrastructure-level code that genuinely needs the system clock for non-business purposes — writing a log timestamp, setting an HTTP response header date, recording a telemetry event — can use `DateTime.UtcNow` directly. The rule applies to business logic where the time value affects a business decision (lockout expiry, token validity, rate limit windows, scheduling). Log timestamps controlled by tests produce confusing test logs; they do not affect test correctness.

## Before You Merge
- Is every `DateTime.UtcNow` call in Application and Domain layer replaced with `IDateTimeProvider.UtcNow`?
- Is `IDateTimeProvider` registered as `Singleton` in production — so all services in a single request see the same time?
- Do integration tests create a fresh `FakeDateTimeProvider` instance per test — not shared across tests?
- Are time-dependent business rules (lockout, token expiry, rate limits) covered by unit tests that use `FakeDateTimeProvider.Advance()`?
- Is `DateTime.UtcNow` permitted only in Infrastructure layer code (logging, HTTP headers) — and banned from Application and Domain via a linter rule or architecture test?
