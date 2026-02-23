# Token Hashing and Storage
> Verified against: .NET 9 | C# 13 | System.Security.Cryptography 9.x
> Last reviewed: 2026-02-22

## The Law
Hash all bearer tokens (refresh tokens, password reset tokens, email verification tokens) with HMACSHA256 and a per-token salt before storing — never store the raw token value in the database.

## Why This Kills You At Scale
A DB backup, a misconfigured read replica, a SQL injection, or a rogue DBA reads the `RefreshTokens` table — raw tokens are immediately usable to impersonate every active user. Hashed tokens are useless without the raw value. At 100k users, a single DB read translates to 100k compromised sessions if tokens are stored in plain text.

## The Pattern

```csharp
#nullable enable
using System.Security.Cryptography;
using System.Text;

public sealed record HashResult(string Hash, string Salt);

public sealed class TokenHashingService
{
    // ✅ Correct: HMACSHA256 with per-token random salt
    // Why HMACSHA256 not PBKDF2: tokens are high-entropy (512 bits random)
    // so slow hashing is unnecessary — PBKDF2 is for low-entropy passwords
    // HMACSHA256 is fast, secure for high-entropy inputs, and constant-time verifiable
    public async Task<HashResult> HashAsync(string rawToken, CancellationToken ct = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(rawToken);

        // 32 bytes = 256-bit salt — unique per token
        var saltBytes = RandomNumberGenerator.GetBytes(32);
        var salt = Convert.ToBase64String(saltBytes);

        var hash = await Task.Run(() => ComputeHmac(rawToken, saltBytes), ct);

        return new HashResult(hash, salt);
    }

    public async Task<bool> VerifyAsync(
        string rawToken,
        string storedHash,
        string storedSalt,
        CancellationToken ct = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(rawToken);
        ArgumentException.ThrowIfNullOrWhiteSpace(storedHash);
        ArgumentException.ThrowIfNullOrWhiteSpace(storedSalt);

        var saltBytes = Convert.FromBase64String(storedSalt);
        var computedHash = await Task.Run(() => ComputeHmac(rawToken, saltBytes), ct);

        // ✅ Constant-time comparison — prevents timing oracle
        return CryptographicOperations.FixedTimeEquals(
            Convert.FromBase64String(computedHash),
            Convert.FromBase64String(storedHash));
    }

    private static string ComputeHmac(string token, byte[] salt)
    {
        // Key = salt, message = token — HMAC binds the two cryptographically
        using var hmac = new HMACSHA256(salt);
        var tokenBytes = Encoding.UTF8.GetBytes(token);
        var hashBytes = hmac.ComputeHash(tokenBytes);
        return Convert.ToBase64String(hashBytes);
    }
}

// ✅ Correct: DB schema — store hash and salt, never raw token
// UserSession:
//   RefreshTokenHash   nvarchar(128)  -- base64 HMACSHA256 = 44 chars, give room
//   RefreshTokenSalt   nvarchar(64)   -- base64 of 32 bytes = 44 chars
//   RefreshTokenExpiry datetime2

// ✅ Correct: lookup pattern — you cannot query by hash without knowing raw token
// So you need a secondary lookup mechanism
public sealed class TokenLookupService
{
    // Strategy 1: store a non-secret prefix of the raw token for lookup
    // Prefix reveals nothing about the full token entropy
    public async Task<UserSession?> FindSessionAsync(string rawToken, CancellationToken ct)
    {
        // First 8 chars of raw token = lookup key (non-secret prefix)
        // Attacker needs the full token to authenticate — prefix alone is useless
        var lookupPrefix = rawToken.Length >= 8 ? rawToken[..8] : rawToken;
        var sessions = await _repo.GetByTokenPrefixAsync(lookupPrefix, ct);

        // Then verify the full token against each candidate
        foreach (var session in sessions)
        {
            if (await _hasher.VerifyAsync(rawToken, session.RefreshTokenHash, session.RefreshTokenSalt, ct))
                return session;
        }
        return null;
    }
}

// ❌ Wrong: raw token in DB
public class InsecureSessionStorage
{
    public async Task StoreAsync(UserSession session, string rawToken, CancellationToken ct)
    {
        session.RefreshToken = rawToken; // DB leak = account takeover
        await _context.SaveChangesAsync(ct);
    }
}

// ❌ Wrong: SHA256 without salt — rainbow table attack possible
public class UnsaltedHash
{
    public string Hash(string token)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(token));
        return Convert.ToHexString(bytes); // No salt = precomputed rainbow tables work
    }
}
```

## The Trap

```csharp
// A senior developer implements hashing correctly.
// Tokens are hashed. Storage is secure. Ships.
// 6 months later: performance degrades under load.

// The trap: every API request that uses a refresh token triggers:
// 1. DB query by prefix (fast)
// 2. HMACSHA256 computation
// 3. CryptographicOperations.FixedTimeEquals
// This is fine for refresh (infrequent). But if someone accidentally puts
// refresh token verification on a hot path (called per request, not per session),
// the crypto overhead becomes measurable at 10k requests/second.

// The fix: access tokens should NEVER be verified by DB lookup — they are
// self-contained JWTs verified by signature only (pure CPU, no DB, no hashing).
// Refresh tokens (verified once per session renewal) use the hash approach above.
// Never conflate the two verification paths.

// Correct call frequency:
// Access token verification: every request — JWT signature check only (CPU, ~0.1ms)
// Refresh token verification: once per session renewal (~15 min) — hash lookup (DB + CPU, ~5ms)
```

## The Exception
API keys issued to developers for server-to-server integrations can use SHA256 without PBKDF2 (but WITH salt) because they are high-entropy (≥256 bits) and not user passwords. PBKDF2 slowness protects against offline cracking of low-entropy values — it adds unnecessary latency for high-entropy tokens where the entropy itself is the protection. The rule is: low-entropy (passwords, PINs) → PBKDF2 or Argon2id. High-entropy (random tokens) → HMACSHA256 or SHA256 with salt.

## Before You Merge
- Is the raw token value absent from every database column, including encrypted columns that internal tooling can decrypt?
- Is the hash computed with a unique per-token random salt — not a shared application secret?
- Is token comparison done via `CryptographicOperations.FixedTimeEquals` — not `string ==` or `.Equals()`?
- Is the lookup mechanism for hashed tokens using a non-secret prefix or separate index — not a full table scan?
- Are access token verifications (every request) using JWT signature only — never hitting the DB?
