# API Versioning
> Verified against: .NET 9 | C# 13 | Asp.Versioning.Http 8.x
> Last reviewed: 2026-02-22

## The Law
Version APIs from day one using URL path versioning (`/api/v1/`) — retrofitting versioning onto an unversioned API while clients depend on it is a breaking change at the worst possible time.

## Why This Kills You At Scale
You ship a breaking change to your API. Your Angular web app is updated. Your mobile app (iOS) is on version 1.2 and 40% of users have not updated — they cannot update (enterprise lockdown, app store review delay). The unversioned API is now broken for 40,000 users. At 100k users, a single breaking change on an unversioned API is a customer support crisis with no technical solution except rollback.

## The Pattern

```csharp
#nullable enable
using Asp.Versioning;

// ✅ Correct: setup API versioning in Program.cs
builder.Services.AddApiVersioning(options =>
{
    options.DefaultApiVersion = new ApiVersion(1);
    options.AssumeDefaultVersionWhenUnspecified = true; // Legacy client compatibility
    options.ReportApiVersions = true; // Returns api-supported-versions header
    options.ApiVersionReader = new UrlSegmentApiVersionReader(); // /api/v1/
})
.AddApiExplorer(options =>
{
    options.GroupNameFormat = "'v'VVV";  // v1, v2, v3
    options.SubstituteApiVersionInUrl = true;
});

// ✅ Correct: versioned controller
[ApiController]
[Route("api/v{version:apiVersion}/[controller]")]
[ApiVersion(1)]
[ApiVersion(2)]
public sealed class ConversationsController : ControllerBase
{
    // ✅ Available in both v1 and v2 — no changes needed
    [HttpGet("{id:guid}")]
    public async Task<ActionResult<ConversationDto>> GetById(Guid id, CancellationToken ct)
        => Ok(await _service.GetByIdAsync(id, ct));

    // ✅ v1 behavior — original response shape
    [HttpGet]
    [MapToApiVersion(1)]
    public async Task<ActionResult<List<ConversationDto>>> GetAllV1(CancellationToken ct)
        => Ok(await _service.GetAllAsync(ct));

    // ✅ v2 behavior — new response shape with pagination, cursor-based
    [HttpGet]
    [MapToApiVersion(2)]
    public async Task<ActionResult<PagedResult<ConversationDto>>> GetAllV2(
        [FromQuery] string? cursor,
        [FromQuery] int pageSize = 20,
        CancellationToken ct = default)
        => Ok(await _service.GetPagedAsync(cursor, pageSize, ct));
}

// ✅ Correct: deprecating a version — warn before removing
[ApiVersion(1, Deprecated = true)] // Returns Sunset and Deprecation headers
[ApiVersion(2)]
public sealed class MessagesController : ControllerBase { }

// ✅ Correct: version-specific services if response shapes diverge significantly
public interface IConversationServiceV1
{
    Task<List<ConversationDto>> GetAllAsync(CancellationToken ct);
}

public interface IConversationServiceV2
{
    Task<PagedResult<ConversationDto>> GetPagedAsync(string? cursor, int pageSize, CancellationToken ct);
}

// ✅ Correct: Swagger per version
builder.Services.AddSwaggerGen(options =>
{
    options.SwaggerDoc("v1", new OpenApiInfo { Title = "Chat API", Version = "v1" });
    options.SwaggerDoc("v2", new OpenApiInfo { Title = "Chat API", Version = "v2" });
});

// ❌ Wrong: breaking change without versioning
[HttpGet] // Was: returns List<ConversationDto>
public async Task<IActionResult> GetAll() // Now: returns PagedResult<ConversationDto>
{
    // Mobile clients parsing the old format now get unexpected JSON structure
    return Ok(await _service.GetPagedAsync(null, 20, default));
}
```

## The Trap

```csharp
// A senior developer sets up URL versioning correctly.
// v1 and v2 both work. Ships.
// The trap: adding a new required field to a response DTO breaks deserialisation
// for clients expecting the old shape — even within the SAME version.

// This is an ADDITIVE change — safe:
public sealed class ConversationDtoV1
{
    public Guid Id { get; set; }
    public string Title { get; set; } = string.Empty;
    // Adding a new nullable field: safe — old clients ignore unknown JSON fields
    public DateTime? LastMessageAt { get; set; }
}

// This is a BREAKING change — requires a new version:
public sealed class ConversationDtoBroken
{
    public Guid Id { get; set; }
    // Was: public string Title — now renamed
    // Old clients expecting "title" get null. New clients expecting "name" get null.
    public string Name { get; set; } = string.Empty; // Breaking — field renamed
}

// This is also a BREAKING change:
public sealed class ConversationDtoBroken2
{
    public Guid Id { get; set; }
    // Was: public string? LastMessagePreview
    // Now: required, non-nullable — old API clients may not send this field
    public required string LastMessagePreview { get; set; } // Breaking — made required
}

// Rule: any of these require a new API version:
// - Field renamed
// - Field type changed
// - Field removed
// - Field made required (was optional)
// - Enum value removed
// - HTTP method changed
// - Route changed
// These are ALWAYS safe (additive):
// - New optional field added to response
// - New optional query parameter
// - New endpoint added
// - New enum value added (if clients handle unknown values)
```

## The Exception
Internal APIs consumed exclusively by first-party clients you deploy atomically (your own Angular web app behind a CDN with cache invalidation on every deploy) can skip versioning — you control both sides of the contract and deploy atomically. The rule applies to any API where you cannot guarantee the client version. The moment a mobile app, a third-party integration, or a partner system consumes your API, versioning is mandatory.

## Before You Merge
- Is `[ApiVersion(X)]` declared on every new controller — not assuming the default?
- Are breaking changes (field renames, type changes, required fields added) introduced in a new version — not in-place?
- Is `[ApiVersion(X, Deprecated = true)]` set on old versions being phased out — with a documented sunset date?
- Is `AssumeDefaultVersionWhenUnspecified = true` set — so legacy clients without version in URL still work during migration?
- Does Swagger generate separate docs per version — not a single merged document?
