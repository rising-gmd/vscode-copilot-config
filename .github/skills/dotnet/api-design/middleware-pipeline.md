# Middleware Pipeline
> Verified against: .NET 9 | C# 13 | ASP.NET Core 9.x
> Last reviewed: 2026-02-22

## The Law
Middleware order is execution order — place security middleware before routing, exception handling before everything, and never perform I/O inside middleware that runs on every request.

## Why This Kills You At Scale
`UseAuthentication()` placed after `UseAuthorization()` means authorization decisions are made before the user identity is established — every request that should be `401 Unauthorized` silently passes as anonymous. At 100k users, wrong middleware order is not caught by unit tests, not caught by integration tests that don't test the full pipeline, and produces intermittent security failures that manifest only in production.

## The Pattern

```csharp
#nullable enable

// ✅ Correct: canonical middleware order for ASP.NET Core API
var app = builder.Build();

// 1. Exception handling — first in, last out, catches everything below it
app.UseExceptionHandler();

// 2. HTTPS redirect — before any auth or routing
if (!app.Environment.IsDevelopment())
    app.UseHttpsRedirection();

// 3. HSTS — production only
if (app.Environment.IsProduction())
    app.UseHsts();

// 4. Security headers — applied to all responses
app.UseMiddleware<SecurityHeadersMiddleware>();

// 5. Correlation ID — before logging so every log line has a correlation ID
app.UseMiddleware<CorrelationIdMiddleware>();

// 6. Request logging — after correlation ID
app.UseSerilogRequestLogging();

// 7. Forwarded headers — before rate limiting so real IP is known
app.UseForwardedHeaders(new ForwardedHeadersOptions
{
    ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto
});

// 8. Rate limiting — after forwarded headers so real IP is used
app.UseRateLimiter();

// 9. CORS — before authentication, OPTIONS preflight must succeed without auth
app.UseCors("ProductionPolicy");

// 10. Routing — establishes endpoint context
app.UseRouting();

// 11. Authentication — MUST come before Authorization
app.UseAuthentication();

// 12. Authorization — MUST come after Authentication
app.UseAuthorization();

// 13. Antiforgery — after auth so we know who the user is
app.UseAntiforgery();

// 14. Endpoints — last in the pipeline
app.MapControllers();
app.MapHub<ChatHub>("/hubs/chat");
app.MapHealthChecks("/health");

// ✅ Correct: custom middleware — lightweight, no I/O on every request
public sealed class CorrelationIdMiddleware(RequestDelegate next)
{
    private const string CorrelationIdHeader = "X-Correlation-ID";

    public async Task InvokeAsync(HttpContext context)
    {
        // ✅ Reuse incoming correlation ID from upstream services, or generate new one
        var correlationId = context.Request.Headers[CorrelationIdHeader].FirstOrDefault()
            ?? Guid.NewGuid().ToString("N");

        context.Items["CorrelationId"] = correlationId;
        context.Response.Headers.Append(CorrelationIdHeader, correlationId);

        // ✅ Add to log context — all logs within this request carry the correlation ID
        using (Serilog.Context.LogContext.PushProperty("CorrelationId", correlationId))
        {
            await next(context);
        }
    }
}

// ❌ Wrong: I/O in middleware — runs on EVERY request including static files
public sealed class BadMiddleware(RequestDelegate next)
{
    public async Task InvokeAsync(HttpContext context, AppDbContext dbContext)
    {
        // BUG: DB call on every request — including health checks, favicon, assets
        var settings = await dbContext.Settings.FirstOrDefaultAsync(); // Never do this
        await next(context);
    }
}
```

## The Trap

```csharp
// A senior developer orders middleware correctly.
// Authentication before authorization. Works in testing. Ships.
// The trap: MapHub for SignalR requires UseAuthentication to have run already.
// But UseRouting is called before UseAuthentication in some tutorials.
// The result: WebSocket upgrade requests fail authentication because
// the JWT is read from the cookie AFTER routing has already processed the request.

// The correct order for SignalR with cookie auth:
app.UseRouting();
app.UseAuthentication(); // Must process the cookie before the hub middleware sees the request
app.UseAuthorization();
app.MapHub<ChatHub>("/hubs/chat"); // Now authentication context is available in hub

// The second trap: adding middleware inside Map* branches
app.Map("/api", branch =>
{
    branch.UseMiddleware<ApiKeyMiddleware>(); // Only applies to /api routes
    branch.UseRouting();
    branch.UseEndpoints(endpoints => endpoints.MapControllers());
});
// This is valid for branching, but SecurityHeadersMiddleware and rate limiting
// must still be in the main pipeline to cover ALL routes including /hubs and /health.
// A common mistake is adding security middleware to a branch, leaving other routes unprotected.
```

## The Exception
`MapStaticAssets()` or `UseStaticFiles()` should be placed early in the pipeline (after HTTPS redirect, before routing) to short-circuit static file requests before they pass through authentication, authorization, and business middleware. Static files are public by definition — running them through the full auth pipeline wastes CPU on every CSS/JS asset request. The exception to "security first" is static file serving, because static files have no security context to evaluate.

## Before You Merge
- Is `UseAuthentication()` placed before `UseAuthorization()` — never after or swapped?
- Is `UseExceptionHandler()` the first middleware registered?
- Is `UseCors()` placed before `UseAuthentication()` — so OPTIONS preflight requests succeed without auth?
- Is `UseForwardedHeaders()` placed before `UseRateLimiter()` — so rate limiting uses the real client IP?
- Is there any I/O (DB calls, cache reads, HTTP calls) in middleware that runs on every request — if so, move it to an action filter or service scoped to specific endpoints?
