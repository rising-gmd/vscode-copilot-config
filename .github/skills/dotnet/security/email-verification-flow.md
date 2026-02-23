# Email Verification Flow
> Verified against: .NET 9 | C# 13 | ASP.NET Core 9.x
> Last reviewed: 2026-02-22

## The Law
Make email verification token consumption atomic at the database level — a single SQL UPDATE with a WHERE clause on the token value, checking rows affected, is the only correct implementation.

## Why This Kills You At Scale
Two simultaneous clicks of a verification link (mobile pre-fetch + user tap, or email client scanner + user click) both read the token as valid, both mark the email as verified — but if the token is not consumed atomically, a race condition means an attacker can use a stolen verification token after the legitimate user has already consumed it, or the legitimate user gets a confusing "already verified" error and contacts support. At scale, email pre-fetchers hit every verification link automatically.

## The Pattern

```csharp
#nullable enable

// ✅ Correct: atomic verification in Dapper repository — one SQL UPDATE does the work
public sealed class DapperUserRepository(IDbConnectionFactory connectionFactory)
{
    public async Task<int> VerifyEmailByTokenAsync(string token, CancellationToken ct)
    {
        using var connection = connectionFactory.CreateConnection();

        // ✅ Single atomic UPDATE — if token matches and not yet verified, consume it
        // Returns rows affected: 1 = success, 0 = already verified or invalid token
        const string sql = """
            UPDATE Users
            SET IsEmailVerified = 1,
                EmailVerificationToken = NULL,
                EmailVerificationTokenExpiry = NULL
            WHERE EmailVerificationToken = @Token
              AND IsEmailVerified = 0
              AND EmailVerificationTokenExpiry > GETUTCDATE()
            """;

        return await connection.ExecuteAsync(
            new CommandDefinition(sql, new { Token = token }, cancellationToken: ct));
    }
}

// ✅ Correct: service layer uses atomic result to determine response
public sealed class AuthService
{
    public async Task<bool> VerifyEmailAsync(string token, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(token))
            throw new AppException(ResponseCodes.TOKEN_REQUIRED, "Token is required");

        var actualToken = DecodeIfBase64Wrapped(token);

        // ✅ Atomic: rows == 1 means we consumed the token, rows == 0 means already consumed
        var rows = await _dapperRepo.VerifyEmailByTokenAsync(actualToken, ct);

        if (rows == 0)
        {
            // Could be: expired, already verified, or invalid — safe to say same thing for all
            throw new AppException(ResponseCodes.TOKEN_INVALID, "Token is invalid or already used");
        }

        _logger?.LogInformation("Email verified via token — rows affected: {Rows}", rows);
        return true;
    }
}

// ✅ Correct: token generation — include email, sign it, set expiry
public sealed class HashingService
{
    public string GenerateEmailVerificationToken(string email, int randomBytes = 32)
    {
        // Token = email (for lookup) + random bytes (for uniqueness + security)
        // Encode email so it survives URL encoding
        var emailPart = Convert.ToBase64String(Encoding.UTF8.GetBytes(email.ToLowerInvariant()));
        var randomPart = Convert.ToBase64String(RandomNumberGenerator.GetBytes(randomBytes));
        // Separator is '.' — distinguishable from base64, URL-safe
        return $"{emailPart}.{randomPart}";
    }

    public string ExtractEmailFromVerificationToken(string token)
    {
        var dotIndex = token.IndexOf('.');
        if (dotIndex <= 0) throw new ArgumentException("Invalid token format");

        var emailPart = token[..dotIndex];
        return Encoding.UTF8.GetString(Convert.FromBase64String(emailPart));
    }
}

// ✅ Correct: resend flow — rate limit strictly
public async Task ResendVerificationEmailAsync(string token, CancellationToken ct)
{
    // Resend limit: 3 times per hour per account
    if (user.LastEmailVerificationSentAt.HasValue &&
        user.LastEmailVerificationSentAt.Value.AddHours(1) > _dateTime.UtcNow &&
        user.EmailVerificationSentCount >= 3)
    {
        throw new AppException(ResponseCodes.TOO_MANY_RESEND_ATTEMPTS, "Too many resend attempts");
    }

    // Generate NEW token — old token is immediately invalid
    var newToken = _hashingService.GenerateEmailVerificationToken(user.Email);
    user.EmailVerificationToken = newToken;
    user.EmailVerificationTokenExpiry = _dateTime.UtcNow.AddDays(3);
    user.EmailVerificationSentCount++;
    user.LastEmailVerificationSentAt = _dateTime.UtcNow;

    await _unitOfWork.SaveChangesAsync(ct);
    _backgroundJobDispatcher.EnqueueVerificationEmail(user.Email, user.Username, newToken);
}

// ❌ Wrong: non-atomic — read then write creates race condition
public async Task VerifyEmailInsecureAsync(string token, CancellationToken ct)
{
    var user = await _repo.GetByVerificationTokenAsync(token, ct); // READ
    if (user is null) throw new AppException("TOKEN_INVALID", "Invalid");
    if (user.IsEmailVerified) throw new AppException("ALREADY_VERIFIED", "Already verified");
    // RACE: two simultaneous requests both pass the check above
    user.IsEmailVerified = true; // WRITE — second request also writes, no error
    await _unitOfWork.SaveChangesAsync(ct);
}
```

## The Trap

```csharp
// A senior developer implements atomic verification correctly.
// The Dapper UPDATE returns rows affected. Works perfectly.
// Then a new developer adds email pre-fetch protection using a "viewed" flag.

// The trap: email security scanners (Gmail, Outlook, corporate proxies) GET every URL
// in every email — including verification links — before the user sees the email.
// The scanner consumes the token. User clicks the link. Token is gone. User can't verify.
// This is reported as a bug. The "fix" is to make verification a two-step process.

// Correct two-step flow for scanner resistance:
// Step 1: GET /verify?token=xxx — show a "Click to confirm" button, do NOT consume token
// Step 2: POST /verify with token in body — atomically consume token, mark verified

// The GET request from the scanner does nothing.
// The POST from the user's browser click consumes the token.

[HttpGet("verify-email")]
[AllowAnonymous]
public IActionResult ShowVerificationConfirmation([FromQuery] string token)
{
    // Do NOT call VerifyEmailAsync here — scanner would consume the token
    // Just show a confirmation page with a button that POSTs the token
    return Ok(new { message = "Click confirm to verify your email", token });
}

[HttpPost("verify-email")]
[AllowAnonymous]
public async Task<IActionResult> ConfirmEmailVerification(
    [FromBody] VerifyEmailRequest request,
    CancellationToken ct)
{
    await _authService.VerifyEmailAsync(request.Token, ct);
    return Ok(new { message = "Email verified successfully" });
}
```

## The Exception
If you use a magic link (clicking the link logs the user in, no separate confirm step), the token must be single-use and short-lived (15 minutes max) and the two-step scanner-resistance approach is mandatory — not optional. Magic links consumed by scanners lock legitimate users out permanently.

## Before You Merge
- Is the token consumption a single atomic SQL `UPDATE ... WHERE token = @token AND IsVerified = 0` — not a read then write?
- Is the verification endpoint a `POST` (not `GET`) to prevent email scanner consumption?
- Does the resend flow generate a completely new token — invalidating the old one immediately?
- Is there a per-account resend rate limit (e.g., 3 per hour) enforced atomically?
- Is token expiry checked in the SQL `WHERE` clause — not in application code after the query?
