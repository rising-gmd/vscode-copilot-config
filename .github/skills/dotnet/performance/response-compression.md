# Response Compression
> Verified against: .NET 9 | C# 13 | ASP.NET Core 9.x
> Last reviewed: 2026-02-22

## The Law
Compress all JSON API responses using Brotli (primary) with gzip fallback — never serve uncompressed text payloads to clients across the internet, and never compress already-compressed content types.

## Why This Kills You At Scale
At one billion users, a 200KB uncompressed conversation history JSON payload served to every user costs 200TB of egress per day. Brotli compression reduces that payload to ~40KB — 80% savings, 800TB/month egress cost eliminated. But the compounding effect is the real win: 80% smaller payloads mean 80% less bandwidth per connection, 80% less time to first byte on mobile networks, 80% less memory pressure in the response buffer on the server. At billion-user scale, compression is not a nice-to-have. It is a financial and performance imperative.

## The Pattern

```csharp
#nullable enable
using Microsoft.AspNetCore.ResponseCompression;
using System.IO.Compression;

// ✅ Correct: configure response compression — Brotli first, gzip fallback
builder.Services.AddResponseCompression(options =>
{
    options.EnableForHttps = true; // ✅ Must be explicitly enabled for HTTPS
    // By default, compression is DISABLED for HTTPS to prevent CRIME/BREACH attacks.
    // For API responses that do not contain secrets (message lists, user profiles),
    // compression over HTTPS is safe. Enable it — the performance gain is massive.
    // Never compress responses that contain user-submitted content mixed with secrets
    // in the same response body (BREACH attack vector).

    options.Providers.Clear();
    options.Providers.Add<BrotliCompressionProvider>();  // Brotli: best ratio, slower
    options.Providers.Add<GzipCompressionProvider>();   // Gzip: fallback for older clients

    // ✅ MIME types to compress — explicit allowlist
    // Only text-based types that compress well
    options.MimeTypes = ResponseCompressionDefaults.MimeTypes.Concat(new[]
    {
        "application/json",
        "application/json; charset=utf-8",
        "application/problem+json",
        "text/plain",
        "text/event-stream", // Server-sent events
    });
});

// ✅ Correct: Brotli level — balance compression ratio vs CPU cost
builder.Services.Configure<BrotliCompressionProviderOptions>(options =>
{
    // Quality 4 = good compression ratio with acceptable CPU cost
    // Quality 11 = maximum compression, ~10x more CPU — use only for static assets
    // Quality 1 = fastest, worst ratio — for real-time streaming where latency matters
    options.Level = CompressionLevel.Optimal; // Maps to ~quality 4 — best for APIs
});

builder.Services.Configure<GzipCompressionProviderOptions>(options =>
{
    options.Level = CompressionLevel.SmallestSize; // Gzip is CPU-cheap; go small
});

// ✅ Correct: middleware order — compression MUST be early in pipeline
var app = builder.Build();

app.UseResponseCompression(); // MUST be before any middleware that writes responses
app.UseHttpsRedirection();
app.UseAuthentication();
app.UseAuthorization();
app.MapControllers();

// ✅ Correct: verify compression is active — check response headers in dev
// Expected headers on compressed response:
// Content-Encoding: br          (Brotli)
// Vary: Accept-Encoding          (tells CDNs to cache separately per encoding)

// ✅ Correct: CDN layer compression configuration reference (Azure CDN / Front Door)
// Use Standard_Microsoft or Premium_AzureFrontDoor SKU which compresses at edge
// Edge compression + origin compression = only one compression needed
// If CDN compresses: disable origin compression (saves CPU)
// If CDN does NOT compress: origin MUST compress (for clients not behind CDN)
// Verify with: curl -H "Accept-Encoding: br" https://api.yourdomain.com/health -v

// ✅ Correct: never compress these — already compressed or too small to benefit
// - JPEG, PNG, GIF, WebP images: already compressed, re-compressing wastes CPU
// - MP4, WebM video: already compressed
// - .zip, .gz files: already compressed
// - Responses < 1KB: compression overhead exceeds savings
// - Binary protobuf: marginal gains, high CPU cost

// ✅ Correct: per-response compression opt-out for specific endpoints
// Some endpoints benefit from skipping compression:
// - Webhook delivery (payload is fixed, client controls format)
// - File download streams (content already compressed)

[HttpGet("export")]
[DisableResponseCompression] // Explicit opt-out — file is already compressed
public async Task<IActionResult> ExportData(CancellationToken ct)
{
    var stream = await _exportService.GenerateCompressedArchiveAsync(ct);
    return File(stream, "application/zip", "export.zip");
}
```

## The Trap

```csharp
// A senior developer enables Brotli with gzip fallback.
// EnableForHttps = true. Middleware in correct position. Ships.
// The trap: SignalR WebSocket traffic is compressed by the middleware layer
// but then double-compressed by SignalR's own compression, causing corrupt frames.

// SignalR has its own built-in compression for WebSocket messages.
// When ASP.NET Core's ResponseCompression middleware sits in front of SignalR,
// it can interfere with SignalR's frame-level compression.
// Result: WebSocket connection drops, clients fail to parse frames,
// real-time messaging silently breaks for clients that negotiate compression.

// Fix: explicitly exclude SignalR hub paths from response compression middleware
app.UseWhen(
    context => !context.Request.Path.StartsWithSegments("/hubs"),
    appBuilder => appBuilder.UseResponseCompression());

// OR: use MapWhen for the entire middleware branch
app.UseResponseCompression(); // Keep this for API routes

// And configure SignalR's own compression separately:
builder.Services.AddSignalR(options =>
{
    // ✅ Enable per-message compression at the SignalR protocol level — not middleware level
    options.EnableDetailedErrors = builder.Environment.IsDevelopment();
});
// In SignalR hub mapping:
// app.MapHub<ChatHub>("/hubs/chat", options =>
// {
//     options.Transports = HttpTransportType.WebSockets | HttpTransportType.LongPolling;
//     // WebSocket compression negotiated at protocol level via Sec-WebSocket-Extensions
// });

// The boundary is clear:
// REST API endpoints → ResponseCompression middleware handles it
// SignalR hubs → SignalR protocol compression handles it
// Never let both touch the same response stream
```

## The Exception
Server-Sent Events (SSE) endpoints that stream individual events should use `CompressionLevel.Fastest` (Brotli quality 1) — the latency of buffering for higher compression levels defeats the purpose of streaming. Real-time event delivery requires low latency over compression ratio. The rule: interactive/streaming endpoints use fastest compression or none, batch/export endpoints use best compression.

## Before You Merge
- Is `EnableForHttps = true` set — compression does not run over HTTPS by default?
- Is `UseResponseCompression()` the first middleware registered — before any middleware that writes to the response body?
- Are already-compressed MIME types (image/jpeg, video/mp4, application/zip) absent from the compression MIME list?
- Are SignalR hub paths excluded from the ResponseCompression middleware — to prevent WebSocket frame corruption?
- Is the Brotli quality level set to `Optimal` (not `SmallestSize`) — balancing compression ratio with CPU cost for APIs?
