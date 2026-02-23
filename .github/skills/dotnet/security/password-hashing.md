# Password Hashing
> Verified against: .NET 9 | C# 13 | Microsoft.AspNetCore.Identity 9.x
> Last reviewed: 2026-02-22

## The Law
Hash passwords with PBKDF2 (minimum 310,000 iterations), Argon2id, or bcrypt — never with MD5, SHA-1, SHA-256, or any general-purpose hash function, with or without a salt.

## Why This Kills You At Scale
A DB leak with SHA-256 password hashes is cracked in hours on a $500 GPU rig — PBKDF2 with 310k iterations makes the same attack take decades. At 100k users, a single breach with weak hashing means every user's password is recoverable, credential stuffing attacks begin within 24 hours, and you are legally liable for the downstream account takeovers on other services where users reused passwords.

## The Pattern

```csharp
#nullable enable
using Microsoft.AspNetCore.Identity;
using System.Security.Cryptography;
using System.Text;

// ✅ Correct: use ASP.NET Core Identity's built-in hasher
// PBKDF2 with HMACSHA256, 310,000 iterations, 128-bit salt, 256-bit subkey
public sealed class PasswordService(IPasswordHasher<PasswordHashTarget> hasher)
{
    // Dummy target — IPasswordHasher<T> doesn't use T for hashing logic,
    // but the type parameter is required. Use a dedicated empty class.
    public string Hash(string plainPassword)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(plainPassword);
        return hasher.HashPassword(new PasswordHashTarget(), plainPassword);
    }

    public bool Verify(string plainPassword, string storedHash)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(plainPassword);
        ArgumentException.ThrowIfNullOrWhiteSpace(storedHash);

        var result = hasher.VerifyHashedPassword(
            new PasswordHashTarget(),
            storedHash,
            plainPassword);

        // ✅ Handle rehash signal — Identity may flag hash as needing upgrade
        // when iteration count increases between versions
        return result != PasswordVerificationResult.Failed;
    }

    public bool NeedsRehash(string plainPassword, string storedHash)
    {
        var result = hasher.VerifyHashedPassword(
            new PasswordHashTarget(),
            storedHash,
            plainPassword);

        // Rehash on next login if iteration count has been increased
        return result == PasswordVerificationResult.SuccessRehashNeeded;
    }
}

public sealed class PasswordHashTarget { }

// ✅ Correct: register in DI
// builder.Services.AddScoped<IPasswordHasher<PasswordHashTarget>, PasswordHasher<PasswordHashTarget>>();
// builder.Services.AddScoped<PasswordService>();

// ✅ Correct: rehash on successful login if needed
public async Task<LoginResponse> LoginAsync(string identifier, string password, CancellationToken ct)
{
    var user = await _userRepository.GetByEmailAsync(identifier, ct);
    if (user is null) throw new AppException("INVALID_CREDENTIALS", "Invalid credentials");

    if (!_passwordService.Verify(password, user.PasswordHash))
        throw new AppException("INVALID_CREDENTIALS", "Invalid credentials");

    // Transparently upgrade hash strength without forcing password reset
    if (_passwordService.NeedsRehash(password, user.PasswordHash))
    {
        user.PasswordHash = _passwordService.Hash(password);
        await _unitOfWork.SaveChangesAsync(ct);
    }

    return await CreateSessionAsync(user, ct);
}

// ❌ Wrong: SHA-256 — fast hash = GPU crackable
public class InsecurePasswordService
{
    public string Hash(string password)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(password));
        return Convert.ToHexString(bytes); // Cracks in minutes
    }
}

// ❌ Wrong: PBKDF2 with too few iterations — check OWASP annually
public class WeakPbkdf2Service
{
    public string Hash(string password)
    {
        // 10,000 iterations — OWASP minimum was 310,000 in 2023
        var salt = RandomNumberGenerator.GetBytes(16);
        var hash = Rfc2898DeriveBytes.Pbkdf2(password, salt, 10_000, HashAlgorithmName.SHA256, 32);
        return $"{Convert.ToBase64String(salt)}:{Convert.ToBase64String(hash)}";
    }
}
```

## The Trap

```csharp
// A senior developer correctly uses PBKDF2 but stores the hash result wrong.
// This passes every test. The bug surfaces only during a migration or restore.

public class PasswordRepository
{
    public async Task UpdatePasswordAsync(Guid userId, string newHash, CancellationToken ct)
    {
        await _context.Users
            .Where(u => u.Id == userId)
            .ExecuteUpdateAsync(s => s
                .SetProperty(u => u.PasswordHash, newHash), ct);
        // BUG: PasswordHash column is nvarchar(128) — the Identity hasher V3 format
        // produces a base64 string that is 172 characters long.
        // The column silently truncates to 128 characters.
        // Hash verification fails for all users who change their password after migration.
        // Original hashed-at-registration passwords work fine — different code path set them.
        // You discover this 30 days later when password reset tokens stop working.
        //
        // Fix: PasswordHash column must be nvarchar(256) minimum.
        // Identity V3 format: "AQ" prefix + base64(salt + subkey) = ~172 chars.
        // Always check column length when changing hashing library or version.
    }
}
```

## The Exception
If integrating with a legacy system that stores passwords in a format you cannot migrate (bcrypt, scrypt, old PBKDF2 iteration count), verify against the legacy format and transparently rehash to the current standard on successful login. Never force a mass password reset — you will lose 30-40% of your user base. Migrate lazily over 90 days as users log in, then force reset for the remaining accounts that have not logged in.

## Before You Merge
- Is `PasswordHash` column in the database `nvarchar(256)` or wider?
- Is the hashing algorithm PBKDF2, Argon2id, or bcrypt — with no exceptions for "internal" users or test accounts?
- Does the login flow check `PasswordVerificationResult.SuccessRehashNeeded` and rehash transparently?
- Are plain-text passwords absent from all log statements, including debug-level logs?
- Is the comparison done through the hasher — not string equality on the hash value?
