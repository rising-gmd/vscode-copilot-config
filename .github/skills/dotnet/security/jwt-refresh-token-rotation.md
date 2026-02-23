# JWT Refresh Token Rotation
> Verified against: .NET 9 | C# 13 | Microsoft.AspNetCore.Authentication.JwtBearer 9.x
> Last reviewed: 2026-02-22

## The Law
Hash refresh tokens with a unique salt before storing — never persist the raw token value, and rotate on every use.

## Why This Kills You At Scale
A single SQL injection or DB backup leak exposes every active session for every user simultaneously — raw tokens are immediately usable with zero cracking. Token reuse without rotation means a stolen token stays valid until expiry; at 100k users with 30-day expiry, an attacker has a month-long silent window.

## The Pattern

```csharp
#nullable enable
using System.Security.Cryptography;
using Microsoft.IdentityModel.Tokens;
using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text;

public sealed class JwtTokenService(IOptions<JwtSettings> options)
{
    private readonly JwtSettings _settings = options.Value;
    private readonly byte[] _keyBytes = Encoding.UTF8.GetBytes(options.Value.Secret);

    // ✅ Correct: short-lived access token, claims minimal
    public string GenerateAccessToken(Guid userId, string email, string username, out DateTime expiresAt)
    {
        expiresAt = DateTime.UtcNow.AddMinutes(_settings.AccessTokenExpiryMinutes);

        var claims = new[]
        {
            new Claim(JwtRegisteredClaimNames.Sub, userId.ToString()),
            new Claim(JwtRegisteredClaimNames.Email, email),
            new Claim("username", username),
            // jti prevents token replay within validity window
            new Claim(JwtRegisteredClaimNames.Jti, Guid.NewGuid().ToString()),
        };

        var creds = new SigningCredentials(
            new SymmetricSecurityKey(_keyBytes),
            SecurityAlgorithms.HmacSha256);

        var token = new JwtSecurityToken(
            issuer: _settings.Issuer,
            audience: _settings.Audience,
            claims: claims,
            notBefore: DateTime.UtcNow,
            expires: expiresAt,
            signingCredentials: creds);

        return new JwtSecurityTokenHandler().WriteToken(token);
    }

    // ✅ Correct: cryptographically random, URL-safe, 64 bytes = 512 bits entropy
    public string GenerateRefreshToken()
    {
        var bytes = RandomNumberGenerator.GetBytes(64);
        return Convert.ToBase64String(bytes)
            .Replace("+", "-")
            .Replace("/", "_")
            .TrimEnd('=');
    }
}

public sealed class RefreshTokenHasher(IHashingService hashingService)
{
    // ✅ Correct: hash before storing, rotate on every use
    public async Task<(string hash, string salt)> HashForStorageAsync(
        string rawToken,
        CancellationToken ct)
    {
        // Never store rawToken — only this goes to DB
        var result = await hashingService.HashAsync(rawToken, ct);
        return (result.Hash, result.Salt);
    }

    // ✅ Correct: constant-time compare prevents timing oracle
    public async Task<bool> VerifyAsync(
        string rawToken,
        string storedHash,
        string storedSalt,
        CancellationToken ct)
    {
        return await hashingService.VerifyAsync(rawToken, storedHash, storedSalt, ct);
    }
}

// ❌ Wrong: raw token stored directly — one DB leak = full account takeover
public class InsecureTokenStorage
{
    public void Store(UserSession session, string rawToken)
    {
        session.RefreshToken = rawToken; // Never do this
    }
}

// ❌ Wrong: token not rotated — stolen token valid until expiry
public class InsecureRefresh
{
    public async Task<string> RefreshAsync(string token, UserSession session)
    {
        if (session.RefreshToken == token) // Reuse without rotation
        {
            return GenerateNewAccessToken(session.UserId);
        }
        throw new UnauthorizedException();
    }

    private string GenerateNewAccessToken(Guid userId) => string.Empty; // placeholder
}
```

## The Trap

```csharp
// A senior developer writes this — it passes review, it works in testing
public async Task<RefreshTokenResponse> RefreshAsync(string incomingToken, CancellationToken ct)
{
    var user = await _repo.GetByRefreshTokenHashAsync(incomingToken, ct);
    // BUG: GetByRefreshTokenHashAsync hashes the input and queries by hash —
    // but under concurrent requests (mobile app + background sync both refresh
    // simultaneously), both requests find the SAME valid session.
    // First request rotates the token. Second request finds the OLD hash gone,
    // throws 401, and the user is silently logged out.
    // This is the "refresh token family" problem — detected only under real
    // concurrent mobile clients, never in single-threaded tests.

    if (user is null)
        throw new AppException(ResponseCodes.TOKEN_INVALID, "Invalid token");

    // Rotate
    var newToken = _tokenService.GenerateRefreshToken();
    var hashed = await _hasher.HashForStorageAsync(newToken, ct);
    user.Session!.RefreshTokenHash = hashed.hash;
    user.Session.RefreshTokenSalt = hashed.salt;
    await _unitOfWork.SaveChangesAsync(ct);

    return new RefreshTokenResponse { RefreshToken = newToken };
}

// Fix: use optimistic concurrency with a rowversion/timestamp on UserSession.
// If two requests race, one will get a DbUpdateConcurrencyException — catch it,
// return 401, and let the client retry. Only one rotation wins.
```

## The Exception
If you control both client and server and use short-lived access tokens (≤5 minutes) with no refresh tokens at all — a legitimate session-cookie-only architecture. The rotation rule only applies when refresh tokens exist. If you eliminate refresh tokens entirely by using sliding cookie expiry, this whole document is moot. But the moment you issue a refresh token to any client, every rule here is non-negotiable.

## Before You Merge
- Is the raw refresh token value absent from every database column, log line, and API response body?
- Does every refresh endpoint invalidate the old token hash before issuing the new one?
- Is token verification using constant-time comparison, not string equality?
- Does the UserSession entity have a concurrency token (rowversion) to prevent race conditions on rotation?
- Is the access token expiry ≤ 15 minutes?
