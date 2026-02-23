# Account Lockout
> Verified against: .NET 9 | C# 13 | ASP.NET Core Identity concepts
> Last reviewed: 2026-02-22

## The Law
Increment failed attempt counters atomically in the database and auto-unlock based on server time — never trust client-supplied unlock tokens or reset counters in application memory.

## Why This Kills You At Scale
A race condition in non-atomic lockout increments allows a botnet to send 1,000 parallel login attempts — each reads `FailedAttempts = 4`, increments to 5, writes back — but due to read-write race, the final DB value is 5 instead of 1,000. The lockout never triggers. At scale this is not theoretical; it happens the first time your login endpoint sees real credential stuffing traffic.

## The Pattern

```csharp
#nullable enable
using Microsoft.EntityFrameworkCore;

public sealed class AccountLockoutService(
    IUserRepository userRepository,
    IUnitOfWork unitOfWork,
    IDateTimeProvider dateTime,
    ILogger<AccountLockoutService> logger)
{
    // These live in AppConstants — change in one place, enforced everywhere
    private const int MaxAttempts = 5;
    private static readonly TimeSpan LockoutDuration = TimeSpan.FromMinutes(15);

    // ✅ Correct: validate lockout state, auto-unlock if expired
    public void ValidateLockoutState(User user)
    {
        // Auto-unlock: check expiry BEFORE checking IsLocked flag
        // This handles the case where lockout expired but no login occurred to clear it
        if (user.IsLocked && user.LockedUntil.HasValue && user.LockedUntil <= dateTime.UtcNow)
        {
            // Do NOT save here — let the calling service save after full validation
            // Saving here creates a partial state if subsequent validation fails
            user.IsLocked = false;
            user.LockedUntil = null;
            user.FailedLoginAttempts = 0;
            user.LastFailedLoginAttempt = null;
            logger.LogInformation("Account auto-unlocked for user {UserId}", user.Id);
            return;
        }

        if (user.IsLocked)
        {
            var remaining = user.LockedUntil.HasValue
                ? (int)(user.LockedUntil.Value - dateTime.UtcNow).TotalSeconds
                : 0;

            throw new AppException(
                ResponseCodes.ACCOUNT_LOCKED,
                ErrorMessages.Authentication.AccountLocked,
                new Dictionary<string, object>
                {
                    ["lockedUntil"] = user.LockedUntil!,
                    ["remainingSeconds"] = remaining
                });
        }
    }

    // ✅ Correct: atomic increment via SQL — prevents race condition
    public async Task RecordFailedAttemptAsync(Guid userId, CancellationToken ct)
    {
        // ExecuteUpdateAsync translates to a single atomic SQL UPDATE
        // UPDATE Users SET FailedLoginAttempts = FailedLoginAttempts + 1 WHERE Id = @id
        // This is atomic at the DB level — no read-modify-write race
        await userRepository.IncrementFailedAttemptsAsync(userId, dateTime.UtcNow, ct);

        // Re-fetch to check if we just hit the threshold
        var user = await userRepository.GetByIdAsync(userId, ct);
        if (user is null) return;

        if (user.FailedLoginAttempts >= MaxAttempts)
        {
            await userRepository.LockAccountAsync(userId, dateTime.UtcNow.Add(LockoutDuration), ct);
            logger.LogWarning(
                "Account locked for user {UserId} after {Attempts} failed attempts",
                userId, user.FailedLoginAttempts);
        }
    }

    // ✅ Correct: reset on successful login
    public async Task RecordSuccessfulLoginAsync(User user, string ipAddress, CancellationToken ct)
    {
        user.FailedLoginAttempts = 0;
        user.LastFailedLoginAttempt = null;
        user.IsLocked = false;
        user.LockedUntil = null;
        user.LastLoginAt = dateTime.UtcNow;
        user.LastLoginIp = ipAddress;
        await unitOfWork.SaveChangesAsync(ct);
    }
}

// ✅ Correct: atomic DB operations in repository
public partial class UserRepository
{
    public async Task IncrementFailedAttemptsAsync(Guid userId, DateTime timestamp, CancellationToken ct)
    {
        // Single SQL statement — atomic, no race condition possible
        await _context.Users
            .Where(u => u.Id == userId)
            .ExecuteUpdateAsync(s => s
                .SetProperty(u => u.FailedLoginAttempts, u => u.FailedLoginAttempts + 1)
                .SetProperty(u => u.LastFailedLoginAttempt, timestamp),
                ct);
    }

    public async Task LockAccountAsync(Guid userId, DateTime lockedUntil, CancellationToken ct)
    {
        await _context.Users
            .Where(u => u.Id == userId)
            .ExecuteUpdateAsync(s => s
                .SetProperty(u => u.IsLocked, true)
                .SetProperty(u => u.LockedUntil, lockedUntil),
                ct);
    }
}

// ❌ Wrong: non-atomic increment — race condition under load
public class InsecureLockout
{
    public async Task RecordFailedAsync(User user, CancellationToken ct)
    {
        user.FailedLoginAttempts++; // READ happened earlier — stale value
        if (user.FailedLoginAttempts >= 5)
            user.IsLocked = true;
        await _unitOfWork.SaveChangesAsync(ct); // Overwrites concurrent increments
    }
}
```

## The Trap

```csharp
// A senior developer implements lockout correctly.
// Security team is happy. Ships to production.
// Attacker discovers a denial-of-service vector no one considered.

// The trap: an attacker who knows a target's email can lock their account
// deliberately by sending 5 wrong passwords. This is a legitimate DoS attack
// on any specific user — lock their account before an important deadline,
// force them to contact support, disrupt their business.

// Mitigation 1: progressive lockout — don't lock on first threshold, increase duration
private static TimeSpan GetLockoutDuration(int lockoutCount) => lockoutCount switch
{
    1 => TimeSpan.FromMinutes(5),
    2 => TimeSpan.FromMinutes(15),
    3 => TimeSpan.FromMinutes(60),
    _ => TimeSpan.FromHours(24)
};

// Mitigation 2: notify user via email when account is locked
// So they know they're being targeted, even if they can't log in

// Mitigation 3: trusted IP allowlist — known IPs skip lockout
// (office IP, user's registered home IP)
// Never implement this without explicit user consent and clear UI disclosure

// Most teams never implement any of these mitigations.
// The DoS vector ships to production and is discovered by a disgruntled ex-employee.
```

## The Exception
Internal service accounts used for machine-to-machine authentication (background jobs, microservice calls) should not have lockout — a transient network error causing 5 failed attempts would lock out a critical service at the worst possible moment. Use client certificates or managed identity for machine accounts instead of username/password, which eliminates the lockout question entirely.

## Before You Merge
- Is the failed attempt increment a single atomic SQL `UPDATE ... SET x = x + 1` — not a read-modify-write in application code?
- Does the lockout check auto-unlock expired lockouts on the server using server time — not client-supplied time?
- Is the lockout duration stored in a constant or configuration — not hardcoded in multiple places?
- Does a successful login reset all lockout fields atomically in the same transaction?
- Is there an alert or notification when an account is locked — so the user knows they're being targeted?
