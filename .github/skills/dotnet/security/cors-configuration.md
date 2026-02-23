# CORS Configuration
> Verified against: .NET 9 | C# 13 | ASP.NET Core 9.x
> Last reviewed: 2026-02-22

## The Law
Define an explicit allowlist of origins — never use `AllowAnyOrigin()` in production, and never combine `AllowAnyOrigin()` with `AllowCredentials()` (ASP.NET Core throws at startup, but the intent is still wrong).

## Why This Kills You At Scale
`AllowAnyOrigin()` means any website on the internet can make authenticated cross-origin requests to your API using the victim's cookies — CORS is the browser's last line of defense between your API and malicious sites. At 100k users, `AllowAnyOrigin()` in production turns every user's browser into a potential attack vector for any site that can social-engineer a click.

## The Pattern

```csharp
#nullable enable
using Microsoft.AspNetCore.Cors;

// ✅ Correct: explicit origin allowlist, configured from appsettings
builder.Services.AddCors(options =>
{
    options.AddPolicy("ProductionPolicy", policy =>
    {
        var allowedOrigins = builder.Configuration
            .GetSection("Cors:AllowedOrigins")
            .Get<string[]>()
            ?? throw new InvalidOperationException("Cors:AllowedOrigins not configured");

        policy
            .WithOrigins(allowedOrigins) // ["https://app.yourdomain.com"]
            .AllowAnyMethod()
            .AllowAnyHeader()
            // ✅ Required for cookie-based auth — sends cookies cross-origin
            .AllowCredentials()
            // ✅ Expose custom headers Angular needs to read
            .WithExposedHeaders("X-Correlation-ID", "X-XSRF-TOKEN");
    });

    // ✅ Separate relaxed policy for development only
    options.AddPolicy("DevelopmentPolicy", policy =>
    {
        policy
            .WithOrigins("http://localhost:4200", "https://localhost:4200")
            .AllowAnyMethod()
            .AllowAnyHeader()
            .AllowCredentials();
    });
});

// ✅ Correct: apply correct policy per environment
var corsPolicy = builder.Environment.IsProduction()
    ? "ProductionPolicy"
    : "DevelopmentPolicy";

app.UseCors(corsPolicy); // Must be before UseAuthentication and UseAuthorization

// ✅ Correct: appsettings.Production.json
// {
//   "Cors": {
//     "AllowedOrigins": [
//       "https://app.yourdomain.com",
//       "https://yourdomain.com"
//     ]
//   }
// }

// ✅ Correct: SignalR CORS — separate configuration
builder.Services.AddSignalR();
// SignalR respects the global CORS policy — no separate config needed
// BUT ensure WithOrigins includes the exact origin including port
// "https://app.yourdomain.com" ≠ "https://app.yourdomain.com:443" in some browsers

// ❌ Wrong: AllowAnyOrigin in production
options.AddPolicy("Dangerous", policy =>
{
    policy.AllowAnyOrigin(); // Any website can call your API as your users
});

// ❌ Wrong: this throws at startup in ASP.NET Core (but the intent is still wrong)
options.AddPolicy("Broken", policy =>
{
    policy
        .AllowAnyOrigin()
        .AllowCredentials(); // InvalidOperationException — ASP.NET Core prevents this combo
});
```

## The Trap

```csharp
// A senior developer correctly configures CORS for the web app.
// Everything works. Ships.
// Then a mobile app team adds a React Native app.
// They report CORS errors when calling the API from the app.

// The trap: React Native is NOT a browser — it does not have CORS restrictions.
// CORS is a browser security feature. Native mobile apps are not affected by it.
// The mobile app's "CORS errors" are actually network errors being misreported
// by their HTTP client library, or the app is running in a WebView which DOES enforce CORS.

// The wrong fix: adding "capacitor://" or "ionic://" to AllowedOrigins
// for a production API used by millions of users.

// The correct fix:
// 1. If the app is truly React Native (not WebView): no CORS change needed
//    — investigate the actual network error (TLS, timeout, wrong URL)
// 2. If using WebView (Ionic, Capacitor): add the specific app origin
//    "capacitor://localhost" and "ionic://localhost" — these are known safe origins
//    for native WebView containers, not arbitrary websites

// The distinction matters: "capacitor://localhost" can only be set by your own compiled app.
// A malicious website cannot claim to be "capacitor://localhost".
// This is different from adding "null" to AllowedOrigins (which is what file:// origins send).

// NEVER add "null" to AllowedOrigins — this allows requests from local HTML files
// which attackers can use to bypass CORS entirely.
```

## The Exception
Internal APIs consumed only by server-to-server calls (microservices, background workers, admin CLIs) have no browser clients and therefore need no CORS configuration at all. Adding CORS to these APIs is harmless but unnecessary — more importantly, do not accidentally expose these APIs to browser clients by adding permissive CORS later, thinking "it's just internal." Mark them clearly in documentation as server-only APIs.

## Before You Merge
- Is `AllowAnyOrigin()` absent from all CORS policies in production configuration?
- Are allowed origins loaded from configuration — not hardcoded in Program.cs?
- Is `AllowCredentials()` only paired with explicit `WithOrigins()` — never with `AllowAnyOrigin()`?
- Is `app.UseCors()` called before `app.UseAuthentication()` and `app.UseAuthorization()` in middleware order?
- Are the allowed origins the exact scheme+host+port values — verified against actual Angular app URLs?
