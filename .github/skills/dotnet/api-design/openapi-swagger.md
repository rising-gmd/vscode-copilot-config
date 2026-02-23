# OpenAPI & Swagger
> Verified against: .NET 9 | C# 13 | Swashbuckle.AspNetCore 6.x | Scalar 1.x
> Last reviewed: 2026-02-22

## The Law
Document every endpoint with `[ProducesResponseType]` for all possible responses and XML comments on request/response types — auto-generated Swagger docs with no annotations are useless to API consumers.

## Why This Kills You At Scale
An undocumented API with auto-generated Swagger that shows only `200 OK: object` forces every client developer to reverse-engineer your responses by trial and error. At 100k users with partner integrations, undocumented error codes produce support tickets for every edge case that documentation would have prevented. Every hour a partner developer spends guessing your API behavior is a support cost you pay.

## The Pattern

```csharp
#nullable enable
using Microsoft.OpenApi.Models;
using Swashbuckle.AspNetCore.Annotations;

// ✅ Correct: Swagger configuration with auth, versioning, XML comments
builder.Services.AddSwaggerGen(options =>
{
    options.SwaggerDoc("v1", new OpenApiInfo
    {
        Title = "Chat API",
        Version = "v1",
        Description = "Real-time chat platform API",
        Contact = new OpenApiContact { Name = "Support", Email = "api@yourdomain.com" }
    });

    // ✅ Include XML comments from all projects
    var xmlFiles = Directory.GetFiles(AppContext.BaseDirectory, "*.xml");
    foreach (var xmlFile in xmlFiles)
        options.IncludeXmlComments(xmlFile);

    // ✅ Cookie authentication in Swagger UI — for testing authenticated endpoints
    options.AddSecurityDefinition("cookieAuth", new OpenApiSecurityScheme
    {
        Type = SecuritySchemeType.ApiKey,
        In = ParameterLocation.Cookie,
        Name = "access_token",
        Description = "JWT access token in HttpOnly cookie"
    });

    options.AddSecurityRequirement(new OpenApiSecurityRequirement
    {
        {
            new OpenApiSecurityScheme
            {
                Reference = new OpenApiReference
                    { Type = ReferenceType.SecurityScheme, Id = "cookieAuth" }
            },
            Array.Empty<string>()
        }
    });

    // ✅ Enum values as strings — much more readable than integers in docs
    options.UseInlineDefinitionsForEnums();
});

// ✅ Correct: fully documented controller
[ApiController]
[Route("api/v{version:apiVersion}/[controller]")]
public sealed class MessagesController : ControllerBase
{
    /// <summary>Send a message to a conversation.</summary>
    /// <param name="conversationId">The conversation to send the message to.</param>
    /// <param name="request">The message content and metadata.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>The created message.</returns>
    /// <remarks>
    /// Requires an active conversation membership.
    /// Content is sanitized before storage.
    /// Supply an `Idempotency-Key` header to prevent duplicate sends on retry.
    /// </remarks>
    [HttpPost("{conversationId:guid}/messages")]
    [ProducesResponseType<MessageDto>(StatusCodes.Status201Created)]
    [ProducesResponseType<ValidationProblemDetails>(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    [ProducesResponseType(StatusCodes.Status429TooManyRequests)]
    public async Task<ActionResult<MessageDto>> SendMessage(
        Guid conversationId,
        [FromBody] SendMessageRequest request,
        CancellationToken ct)
    {
        var message = await _messageService.SendAsync(conversationId, request, ct);
        return CreatedAtAction(nameof(GetById), new { messageId = message.Id }, message);
    }
}

// ✅ Correct: XML-documented request/response types
/// <summary>Request to send a message.</summary>
public sealed class SendMessageRequest
{
    /// <summary>The message content. Supports plain text or Markdown.</summary>
    /// <example>Hello! How are you?</example>
    public string Content { get; set; } = string.Empty;

    /// <summary>Whether the content is rich text (Markdown). Default: false.</summary>
    /// <example>false</example>
    public bool IsRichText { get; set; }
}

// ✅ Correct: Scalar as modern Swagger UI alternative (.NET 9)
app.MapScalarApiReference(options =>
{
    options.Title = "Chat API";
    options.Theme = ScalarTheme.Moon;
});

// ❌ Wrong: undocumented endpoint — Swagger shows empty schema
[HttpPost("{conversationId}/messages")] // No ProducesResponseType
public async Task<IActionResult> Send([FromBody] object request) // No typed request
{
    // Swagger generates: 200 OK: {} — useless documentation
    return Ok();
}
```

## The Trap

```csharp
// A senior developer documents all endpoints correctly.
// Swagger looks great. Ships.
// The trap: Swagger UI is accessible in production.

if (app.Environment.IsDevelopment())
{
    app.UseSwagger();
    app.UseSwaggerUI();
}
// This is correct — but a developer later adds:
app.UseSwagger();  // Outside the IsDevelopment block — ships to production
app.UseSwaggerUI(); // Now all your API contracts are publicly browsable

// Swagger in production:
// 1. Exposes all endpoint paths to attackers — speeds up enumeration
// 2. Exposes all request/response schemas — reveals internal data structures
// 3. Allows interactive testing — attackers can call endpoints directly via Swagger UI

// Fix: conditionally expose, or protect with authentication
if (app.Environment.IsDevelopment() || app.Environment.IsStaging())
{
    app.UseSwagger();
    app.UseSwaggerUI();
}

// If you must expose in production (for partner integrations):
app.UseSwagger();
app.MapSwagger().RequireAuthorization("ApiDocsPolicy"); // Auth required to view docs
```

## The Exception
Public APIs with intentional external consumers (developer platform, partner integrations, public SDK) should expose Swagger docs in production — with authentication required to use the interactive UI. The schema itself can be public (it is your documented contract), but the interactive "try it out" feature that makes live requests should require an API key or OAuth token. Never expose the Swagger UI anonymously on a production API that handles user data.

## Before You Merge
- Is every endpoint decorated with `[ProducesResponseType]` for ALL possible status codes including `400`, `401`, `404`, `429`?
- Are request and response types documented with XML `<summary>` and `<example>` tags?
- Is `UseSwagger()` and `UseSwaggerUI()` gated behind `IsDevelopment()` or an authentication requirement?
- Are enum values rendered as strings in Swagger — not integers?
- Does the Swagger definition include the security scheme for cookie auth so developers can test authenticated endpoints?
