# CSRF Protection
> Verified against: .NET 9 | C# 13 | Microsoft.AspNetCore.Antiforgery 9.x
> Last reviewed: 2026-02-22

## The Law
Every cookie-authenticated state-changing endpoint requires antiforgery token validation — SameSite=Strict alone is not sufficient because browser support is not uniform across all versions in production.

## Why This Kills You At Scale
A user on Safari 12 (still 3% of traffic in 2024) visits an attacker page while logged into your app — SameSite=Lax does not protect POST requests on older Safari, and the attacker's page silently submits a form that transfers funds, deletes data, or changes email. At 100k users, 3,000 are potentially vulnerable to silent account manipulation with no logs showing anything unusual.

## The Pattern

```csharp
#nullable enable
using Microsoft.AspNetCore.Antiforgery;

// ✅ Correct: register antiforgery with secure cookie settings
builder.Services.AddAntiforgery(options =>
{
    // Angular reads this cookie and sends value in X-XSRF-TOKEN header
    options.Cookie.Name = "XSRF-TOKEN";
    options.HeaderName = "X-XSRF-TOKEN";
    // NOT HttpOnly — Angular JS must read it to put it in the header
    options.Cookie.HttpOnly = false;
    options.Cookie.Secure = true;
    options.Cookie.SameSite = SameSiteMode.Strict;
});

// ✅ Correct: endpoint that generates and sends the antiforgery token
// Call this after login and on app bootstrap
[HttpGet("antiforgery-token")]
[AllowAnonymous]
public IActionResult GetAntiforgeryToken([FromServices] IAntiforgery antiforgery)
{
    // Generates token pair — one in cookie, one returned for Angular to store in memory
    var tokens = antiforgery.GetAndStoreTokens(HttpContext);

    // Angular stores this in memory (not localStorage), sends as X-XSRF-TOKEN header
    return Ok(new { token = tokens.RequestToken });
}

// ✅ Correct: validate on all state-changing endpoints
[HttpPost("transfer")]
[ValidateAntiForgeryToken]
public async Task<IActionResult> Transfer([FromBody] TransferRequest request, CancellationToken ct)
{
    await _transferService.ExecuteAsync(request, ct);
    return Ok();
}

// ✅ Correct: global filter — safer than per-endpoint decoration
builder.Services.AddControllers(options =>
{
    // Apply to ALL POST/PUT/PATCH/DELETE — opt out per endpoint with [IgnoreAntiforgeryToken]
    options.Filters.Add(new AutoValidateAntiforgeryTokenAttribute());
});

// ✅ Correct: Angular HTTP interceptor — add to every mutating request
// (TypeScript, for reference only)
// intercept(req: HttpRequest<any>, next: HttpHandler) {
//   if (['POST','PUT','PATCH','DELETE'].includes(req.method)) {
//     const token = this.tokenService.getAntiforgeryToken();
//     req = req.clone({ headers: req.headers.set('X-XSRF-TOKEN', token) });
//   }
//   return next.handle(req);
// }

// ❌ Wrong: relying on SameSite alone — browser support is not 100%
[HttpPost("transfer-insecure")]
public async Task<IActionResult> TransferInsecure([FromBody] TransferRequest request, CancellationToken ct)
{
    // No antiforgery validation — Safari 12, IE11 users are vulnerable
    await _transferService.ExecuteAsync(request, ct);
    return Ok();
}
```

## The Trap

```csharp
// A senior developer correctly sets up antiforgery globally.
// It works perfectly. Then they add a webhook endpoint.

[HttpPost("webhooks/stripe")]
[ValidateAntiForgeryToken] // BUG: Stripe cannot send your antiforgery token
public async Task<IActionResult> StripeWebhook(CancellationToken ct)
{
    // This returns 400 for every Stripe webhook — payments silently fail.
    // Discovered when refunds stop processing and finance notices 3 days later.
    // Fix: use [IgnoreAntiforgeryToken] on webhook endpoints,
    // and validate Stripe-Signature header instead (HMAC-SHA256 of payload).
    var payload = await new StreamReader(Request.Body).ReadToEndAsync(ct);
    return Ok();
}

// The correct webhook endpoint:
[HttpPost("webhooks/stripe")]
[IgnoreAntiforgeryToken] // Explicitly opt out — document WHY
[AllowAnonymous]
public async Task<IActionResult> StripeWebhookSecure(CancellationToken ct)
{
    var payload = await new StreamReader(Request.Body).ReadToEndAsync(ct);
    var signature = Request.Headers["Stripe-Signature"].ToString();

    // Validate Stripe's HMAC signature instead — this IS the CSRF protection for webhooks
    if (!_stripeService.ValidateWebhookSignature(payload, signature))
        return Unauthorized();

    await _stripeService.ProcessWebhookAsync(payload, ct);
    return Ok();
}
```

## The Exception
Pure API servers consumed exclusively by mobile native apps or server-to-server communication do not need antiforgery tokens — cookies are not the authentication mechanism, so CSRF does not apply. However, the moment a browser client consuming cookies is added to the same API, antiforgery must be activated. A single API serving both mobile and browser clients must validate antiforgery for browser sessions and skip it for Bearer token sessions — use `[IgnoreAntiforgeryToken]` on endpoints that explicitly handle both via Bearer.

## Before You Merge
- Is `AutoValidateAntiforgeryTokenAttribute` registered globally in `AddControllers`?
- Does every webhook or third-party callback endpoint have `[IgnoreAntiforgeryToken]` with a comment explaining the alternative validation used?
- Is the `XSRF-TOKEN` cookie `HttpOnly = false` so Angular can read it?
- Is the Angular HTTP interceptor adding `X-XSRF-TOKEN` to all mutating requests?
- Is the antiforgery cookie `Secure = true` in production configuration?
