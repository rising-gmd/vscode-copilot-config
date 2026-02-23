# Cookie Authentication
> Verified against: .NET 9 | C# 13 | Microsoft.AspNetCore.Authentication.Cookies 9.x
> Last reviewed: 2026-02-22

## The Law
Store authentication state in HttpOnly, Secure, SameSite=Strict cookies — never in localStorage, sessionStorage, or JavaScript-accessible memory.

## Why This Kills You At Scale
A single XSS vulnerability in any third-party script on your page drains every active session when tokens live in localStorage — one compromised CDN script, every user logged out and impersonated simultaneously. SameSite=Lax instead of Strict allows CSRF on same-site navigation in browsers that treat top-level navigation as same-site, silently executing state-changing requests from attacker-controlled pages.

## The Pattern

```csharp
#nullable enable
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Authentication.JwtBearer;

// ✅ Correct: in Program.cs — cookie carries the JWT, JS never touches it
builder.Services.AddAuthentication(options =>
{
    options.DefaultAuthenticateScheme = JwtBearerDefaults.AuthenticationScheme;
    options.DefaultChallengeScheme = JwtBearerDefaults.AuthenticationScheme;
})
.AddJwtBearer(options =>
{
    options.TokenValidationParameters = new TokenValidationParameters
    {
        ValidateIssuerSigningKey = true,
        IssuerSigningKey = new SymmetricSecurityKey(
            Encoding.UTF8.GetBytes(builder.Configuration["Jwt:Secret"]!)),
        ValidateIssuer = true,
        ValidIssuer = builder.Configuration["Jwt:Issuer"],
        ValidateAudience = true,
        ValidAudience = builder.Configuration["Jwt:Audience"],
        ValidateLifetime = true,
        // 30 seconds only — clock skew is not your friend at scale
        ClockSkew = TimeSpan.FromSeconds(30),
    };

    // ✅ Correct: SignalR cannot send Authorization header — read from cookie
    options.Events = new JwtBearerEvents
    {
        OnMessageReceived = context =>
        {
            var path = context.HttpContext.Request.Path;
            if (path.StartsWithSegments("/hubs"))
            {
                // Cookie name must match what your auth controller sets
                var token = context.Request.Cookies["access_token"];
                if (!string.IsNullOrEmpty(token))
                    context.Token = token;
            }
            return Task.CompletedTask;
        }
    };
});

// ✅ Correct: cookie settings — HttpOnly blocks JS, Secure blocks HTTP, Strict blocks CSRF
public static class CookieHelper
{
    public static CookieOptions CreateSecureOptions(bool isProduction) => new()
    {
        HttpOnly = true,
        Secure = isProduction, // false in dev so HTTP works locally
        SameSite = SameSiteMode.Strict,
        // Do not set Domain — scopes to exact host, prevents subdomain theft
        Path = "/",
        Expires = DateTimeOffset.UtcNow.AddMinutes(15) // match access token expiry
    };
}

// ✅ Correct: set cookie in controller, never return token in body
[HttpPost("login")]
public async Task<IActionResult> Login([FromBody] LoginRequest request, CancellationToken ct)
{
    var response = await _authService.LoginAsync(request.Identifier, request.Password, ct);

    Response.Cookies.Append("access_token", response.AccessToken,
        CookieHelper.CreateSecureOptions(Environment.IsProduction()));

    Response.Cookies.Append("refresh_token", response.RefreshToken,
        CookieHelper.CreateSecureOptions(Environment.IsProduction()) with
        {
            Path = "/api/auth/refresh", // Restrict refresh cookie to refresh endpoint only
            Expires = DateTimeOffset.UtcNow.AddDays(30)
        });

    // ✅ Return only non-sensitive user info — no tokens in body
    return Ok(new { response.UserId, response.Username, response.DisplayName });
}

// ❌ Wrong: token in response body — Angular stores it, XSS steals it
[HttpPost("login-insecure")]
public async Task<IActionResult> LoginInsecure([FromBody] LoginRequest request, CancellationToken ct)
{
    var response = await _authService.LoginAsync(request.Identifier, request.Password, ct);
    return Ok(response); // Never return tokens in body to browser clients
}
```

## The Trap

```csharp
// A senior developer sets this up correctly in development, ships to production.
// Looks right. Passes review. Breaks in production for mobile clients.

builder.Services.ConfigureApplicationCookie(options =>
{
    options.Cookie.SameSite = SameSiteMode.Strict;
});

// The trap: SameSite=Strict breaks OAuth flows and mobile deep links.
// When a user clicks "Login with Google" and is redirected back, 
// SameSite=Strict means the browser does NOT send the cookie on that
// top-level cross-site navigation. User lands on callback URL, no cookie,
// 401, confused user.
//
// The fix is not to weaken to Lax globally — it is to use SameSite=Lax
// ONLY for the OAuth callback cookie, and keep Strict for the session cookie.
// Most teams discover this at 3am when their OAuth provider changes redirect behavior.
//
// Additionally: setting Secure=true in development causes silent cookie rejection
// on HTTP localhost in Chrome — the cookie is set, the browser silently drops it,
// and you spend 2 hours debugging auth before checking chrome://net-internals/#cookies
```

## The Exception
Mobile native apps (iOS/Android) cannot use HttpOnly cookies — they use Bearer tokens in Authorization headers stored in the platform secure keychain (Keychain on iOS, Keystore on Android). The cookie rules apply exclusively to browser clients. For mobile, issue tokens in the response body, store in platform keychain, send as Authorization: Bearer. Never localStorage. Never AsyncStorage without encryption.

## Before You Merge
- Is `HttpOnly = true` on every cookie that carries authentication state?
- Is the refresh token cookie scoped to `/api/auth/refresh` path only?
- Is `Secure = true` in production configuration (not hardcoded false)?
- Is `SameSite` set explicitly — not left to browser default which varies by version?
- Are access tokens absent from every API response body sent to browser clients?
