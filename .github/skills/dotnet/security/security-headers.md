# Security Headers
> Verified against: .NET 9 | C# 13 | ASP.NET Core 9.x
> Last reviewed: 2026-02-22

## The Law
Set `Content-Security-Policy`, `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, and `Strict-Transport-Security` on every response — these are the browser's last enforcement layer when application code fails.

## Why This Kills You At Scale
Missing `X-Frame-Options: DENY` allows clickjacking — an attacker embeds your app in an invisible iframe and tricks users into clicking buttons they cannot see. Missing `X-Content-Type-Options: nosniff` allows MIME-type confusion attacks where a PNG upload is executed as JavaScript by older browsers. These are not theoretical — they are exploited actively against real production apps.

## The Pattern

```csharp
#nullable enable

// ✅ Correct: centralized security headers middleware
public sealed class SecurityHeadersMiddleware(RequestDelegate next)
{
    public async Task InvokeAsync(HttpContext context)
    {
        var headers = context.Response.Headers;

        // Prevent clickjacking — your app should never be in an iframe
        headers.Append("X-Frame-Options", "DENY");

        // Prevent MIME sniffing — browser must use declared Content-Type
        headers.Append("X-Content-Type-Options", "nosniff");

        // Limit referrer info sent to external sites
        headers.Append("Referrer-Policy", "strict-origin-when-cross-origin");

        // Disable browser XSS filter (legacy, can be abused) — CSP replaces it
        headers.Append("X-XSS-Protection", "0");

        // Remove server version disclosure
        headers.Remove("Server");
        headers.Remove("X-Powered-By");

        // ✅ CSP — strict for API, allows WebSocket for SignalR
        // Adjust connect-src for your SignalR hub URL
        headers.Append("Content-Security-Policy",
            "default-src 'self'; " +
            "script-src 'self'; " +
            "style-src 'self' 'unsafe-inline'; " +  // unsafe-inline needed for Angular in some configs
            "img-src 'self' data: https:; " +
            "connect-src 'self' wss: ws:; " +        // WebSocket for SignalR
            "font-src 'self'; " +
            "frame-ancestors 'none'; " +              // Redundant with X-Frame-Options but belt+suspenders
            "base-uri 'self'; " +
            "form-action 'self'");

        // ✅ HSTS — only in production, tell browsers to always use HTTPS
        // max-age=31536000 = 1 year, includeSubDomains = protect all subdomains
        if (context.Request.IsHttps)
        {
            headers.Append("Strict-Transport-Security",
                "max-age=31536000; includeSubDomains; preload");
        }

        // ✅ Permissions Policy — disable features you don't use
        headers.Append("Permissions-Policy",
            "camera=(), microphone=(), geolocation=(), payment=()");

        await next(context);
    }
}

// ✅ Correct: register in Program.cs — must be early in pipeline
app.UseMiddleware<SecurityHeadersMiddleware>();
app.UseHttpsRedirection();

// ✅ Correct: HSTS via built-in middleware (production only)
if (!app.Environment.IsDevelopment())
{
    app.UseHsts();
}

// ❌ Wrong: headers set only on some responses
app.MapGet("/api/data", async (HttpContext ctx) =>
{
    ctx.Response.Headers.Append("X-Frame-Options", "DENY"); // Only this endpoint
    // Every other endpoint is unprotected — middleware is the correct approach
    return Results.Ok();
});
```

## The Trap

```csharp
// A senior developer adds security headers middleware correctly.
// Headers appear on every API response. Security scanner passes.
// Ships. Then the Angular SPA stops working in some browsers.

// The trap: Content-Security-Policy with script-src 'self' breaks:
// 1. Angular's inline event handlers in some component patterns
// 2. PrimeNG components that inject inline styles
// 3. SignalR's negotiation which might load scripts from a CDN
// 4. Any third-party widget (Intercom, analytics, chat support)

// The wrong fix: adding 'unsafe-inline' and 'unsafe-eval' to CSP — this defeats the purpose.

// The correct approach: use CSP nonces for inline scripts
// Server generates a unique nonce per request and embeds it in the HTML
// Angular uses the nonce for its inline scripts

public sealed class CspNonceMiddleware(RequestDelegate next)
{
    public async Task InvokeAsync(HttpContext context)
    {
        // Generate a unique nonce per request
        var nonce = Convert.ToBase64String(RandomNumberGenerator.GetBytes(16));
        context.Items["CspNonce"] = nonce;

        context.Response.Headers.Append("Content-Security-Policy",
            $"default-src 'self'; " +
            $"script-src 'self' 'nonce-{nonce}'; " + // Scripts with matching nonce are allowed
            $"style-src 'self' 'nonce-{nonce}'; " +
            $"connect-src 'self' wss:; " +
            $"frame-ancestors 'none'");

        await next(context);
    }
}

// In Angular: configure the nonce via index.html meta tag
// <meta name="CSP_NONCE" content="{{nonce}}" />
// Angular reads this and applies the nonce to its generated script tags
```

## The Exception
Development environments should skip HSTS (you will lock your browser into HTTPS for localhost, breaking HTTP dev server) and can use a permissive CSP to allow hot module replacement and dev tools. Use `app.Environment.IsDevelopment()` checks explicitly — never ship development headers to staging or production. Staging should mirror production security headers exactly to catch CSP issues before they reach users.

## Before You Merge
- Is `SecurityHeadersMiddleware` registered before `UseRouting` in the middleware pipeline?
- Is `Strict-Transport-Security` only set on HTTPS requests — not on HTTP where it is ignored anyway?
- Does the Content-Security-Policy include `frame-ancestors 'none'` — redundant with X-Frame-Options but required for CSP-aware browsers?
- Are `Server` and `X-Powered-By` headers removed from all responses?
- Has the CSP been verified against the actual Angular app — do PrimeNG and SignalR still work with the policy?
