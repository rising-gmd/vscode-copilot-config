# Secure Token Generation
> Verified against: .NET 9 | C# 13 | System.Security.Cryptography 9.x
> Last reviewed: 2026-02-22

## The Law
Use `RandomNumberGenerator.GetBytes()` for all security tokens — never `Random`, `Guid.NewGuid()`, or any deterministic source.

## Why This Kills You At Scale
`Guid.NewGuid()` uses Version 4 UUID which calls OS CSPRNG — acceptable but its format wastes entropy (6 bits are fixed version/variant markers) and its string representation is predictable in length and character set. `Random` is seeded from system time — two server instances started simultaneously generate identical sequences, and an attacker who knows your server start time can enumerate all tokens issued in the first milliseconds. At 100k users, predictable password reset tokens mean account takeover for any user whose reset email is intercepted.

## The Pattern

```csharp
#nullable enable
using System.Security.Cryptography;
using System.Text;

public static class SecureTokenGenerator
{
    // ✅ Correct: 64 bytes = 512 bits entropy — URL-safe base64
    public static string GenerateUrlSafeToken(int byteLength = 64)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(byteLength, 32);

        var bytes = RandomNumberGenerator.GetBytes(byteLength);
        return Convert.ToBase64String(bytes)
            .Replace("+", "-")
            .Replace("/", "_")
            .TrimEnd('='); // Remove padding — not needed for tokens
    }

    // ✅ Correct: numeric OTP — for SMS verification codes
    public static string GenerateNumericOtp(int digits = 6)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(digits, 4);
        ArgumentOutOfRangeException.ThrowIfGreaterThan(digits, 10);

        // Use rejection sampling to avoid modulo bias
        // Max value that divides evenly into uint range
        var maxValue = (uint)Math.Pow(10, digits);
        uint result;
        do
        {
            var bytes = RandomNumberGenerator.GetBytes(4);
            result = BitConverter.ToUInt32(bytes) % maxValue;
            // Reject values in the biased range to ensure uniform distribution
        } while (result >= uint.MaxValue - (uint.MaxValue % maxValue));

        return result.ToString().PadLeft(digits, '0');
    }

    // ✅ Correct: email verification token with embedded email
    public static string GenerateEmailVerificationToken(string email, int randomBytes = 32)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(email);
        ArgumentOutOfRangeException.ThrowIfLessThan(randomBytes, 16);

        var emailEncoded = Convert.ToBase64String(Encoding.UTF8.GetBytes(email.ToLowerInvariant()))
            .Replace("+", "-").Replace("/", "_").TrimEnd('=');
        var random = GenerateUrlSafeToken(randomBytes);

        // '.' is URL-safe and not in base64url alphabet — safe separator
        return $"{emailEncoded}.{random}";
    }

    // ✅ Correct: constant-time comparison — prevent timing oracle
    public static bool SecureEquals(string? a, string? b)
    {
        if (a is null && b is null) return true;
        if (a is null || b is null) return false;

        // CryptographicOperations.FixedTimeEquals requires same length
        // Pad to same length first — still constant time
        var aBytes = Encoding.UTF8.GetBytes(a);
        var bBytes = Encoding.UTF8.GetBytes(b);

        // XOR lengths — any difference contributes to result
        var result = aBytes.Length ^ bBytes.Length;

        // Compare min-length bytes
        var minLen = Math.Min(aBytes.Length, bBytes.Length);
        for (int i = 0; i < minLen; i++)
            result |= aBytes[i] ^ bBytes[i];

        return result == 0;
    }
}

// ❌ Wrong: Random — predictable, seed-based
public class InsecureTokenGenerator
{
    private static readonly Random _random = new(); // Seed from system time

    public string GenerateToken()
    {
        // Predictable if attacker knows server start time
        return _random.Next(100000, 999999).ToString();
    }
}

// ❌ Wrong: Guid — not designed for security tokens, format predictable
public class GuidTokenGenerator
{
    public string GenerateToken()
    {
        // Version 4 UUID is CSPRNG-based but wastes entropy and looks guessable
        // Never use for security-sensitive tokens
        return Guid.NewGuid().ToString("N");
    }
}

// ✅ Correct: token entropy table — choose based on use case
// Password reset:     32 bytes minimum (256 bits)
// Email verification: 32 bytes minimum
// Session/refresh:    64 bytes recommended (512 bits)
// API keys:          32 bytes minimum, consider 48 for comfort
// OTP (6 digit):     ~20 bits — short-lived (5 min) compensates for low entropy
