# Minimal APIs
> Verified against: .NET 9 | C# 13 | ASP.NET Core 9.x
> Last reviewed: 2026-02-22

## The Law
Organise Minimal API endpoints into `IEndpointRouteBuilder` extension classes grouped by domain — never register 200 endpoints in a flat `Program.cs`, and never use Minimal APIs for complex endpoints that require MVC filter pipelines, model binders, or action-level auth policies.

## Why This Kills You At Scale
At one billion users, the marginal latency difference between Minimal APIs and MVC controllers matters — Minimal APIs have lower per-request overhead because they bypass the MVC filter pipeline, action descriptor resolution, and model binder discovery. A 0.5ms overhead difference at 1 million requests per second is 500 seconds of CPU time saved per second. But unmaintainable Minimal API registration — 400 endpoints in `Program.cs` — kills developer velocity, which at scale kills your ability to fix performance issues fast enough to matter.

## The Pattern

```csharp
#nullable enable
using Microsoft.AspNetCore.Http.HttpResults;

// ✅ Correct: domain endpoint groups — modular, discoverable, testable
// Messages/MessageEndpoints.cs
public static class MessageEndpoints
{
    public static IEndpointRouteBuilder MapMessageEndpoints(
        this IEndpointRouteBuilder app)
    {
        var group = app
            .MapGroup("/api/v1/conversations/{conversationId:guid}/messages")
            .RequireAuthorization()
            .WithTags("Messages")
            .WithOpenApi()
            .AddEndpointFilter<RequestLoggingFilter>(); // Group-level filter

        group.MapGet("/", GetMessages)
             .WithName("GetMessages")
             .WithSummary("Get paginated messages for a conversation")
             .Produces<ApiResponse<PagedResult<MessageDto>>>()
             .Produces(StatusCodes.Status401Unauthorized)
             .Produces(StatusCodes.Status404NotFound)
             .CacheOutput("MessageList"); // Output cache policy

        group.MapPost("/", SendMessage)
             .WithName("SendMessage")
             .WithSummary("Send a message to a conversation")
             .Produces<ApiResponse<MessageDto>>(StatusCodes.Status201Created)
             .Produces<ValidationProblemDetails>(StatusCodes.Status400BadRequest)
             .AddEndpointFilter<IdempotencyFilter>()
             .RequireRateLimiting("SendMessage");

        group.MapDelete("/{messageId:guid}", DeleteMessage)
             .WithName("DeleteMessage")
             .Produces(StatusCodes.Status204NoContent)
             .Produces(StatusCodes.Status403Forbidden);

        return app;
    }

    // ✅ Correct: typed results — compile-time verified, OpenAPI-aware
    private static async Task<Results<Ok<ApiResponse<PagedResult<MessageDto>>>,
                                        NotFound,
                                        ForbidHttpResult>> GetMessages(
        Guid conversationId,
        [AsParameters] PaginationQuery pagination,
        IMessageService messageService,
        ICurrentUserService currentUser,
        CancellationToken ct)
    {
        var userId = currentUser.GetUserId();

        var result = await messageService.GetPagedAsync(
            conversationId, userId, pagination, ct);

        return result is null
            ? TypedResults.NotFound()
            : TypedResults.Ok(ApiResponse.Ok(result));
    }

    private static async Task<Results<Created<ApiResponse<MessageDto>>,
                                      BadRequest<ValidationProblemDetails>,
                                      ForbidHttpResult>> SendMessage(
        Guid conversationId,
        SendMessageRequest request,
        IMessageService messageService,
        ICurrentUserService currentUser,
        CancellationToken ct)
    {
        var userId = currentUser.GetUserId();
        var message = await messageService.SendAsync(conversationId, userId, request, ct);

        return TypedResults.Created(
            $"/api/v1/conversations/{conversationId}/messages/{message.Id}",
            ApiResponse.Ok(message));
    }

    private static async Task<Results<NoContent, NotFound, ForbidHttpResult>> DeleteMessage(
        Guid conversationId,
        Guid messageId,
        IMessageService messageService,
        ICurrentUserService currentUser,
        CancellationToken ct)
    {
        var userId = currentUser.GetUserId();
        await messageService.DeleteAsync(messageId, userId, ct);
        return TypedResults.NoContent();
    }
}

// ✅ Correct: structured DI for endpoint groups using [AsParameters]
// Groups query parameters without requiring a custom model binder
public sealed record PaginationQuery(
    [FromQuery] Guid? Cursor = null,
    [FromQuery] int PageSize = 50,
    [FromQuery] string? OrderBy = null);

// ✅ Correct: endpoint filter for cross-cutting concerns
public sealed class RequestLoggingFilter(ILogger<RequestLoggingFilter> logger)
    : IEndpointFilter
{
    public async ValueTask<object?> InvokeAsync(
        EndpointFilterInvocationContext context,
        EndpointFilterDelegate next)
    {
        var endpoint = context.HttpContext.GetEndpoint()?.DisplayName;
        var sw = System.Diagnostics.Stopwatch.StartNew();
        var result = await next(context);
        sw.Stop();

        if (sw.ElapsedMilliseconds > 500)
            logger.LogWarning("Slow endpoint {Endpoint}: {ElapsedMs}ms",
                endpoint, sw.ElapsedMilliseconds);

        return result;
    }
}

// ✅ Correct: Program.cs — clean, just wires up endpoint groups
var app = builder.Build();
app.UseAuthentication();
app.UseAuthorization();
app.UseRateLimiter();
app.UseResponseCompression();

// One line per domain — all routing logic in the domain endpoint class
app.MapMessageEndpoints();
app.MapConversationEndpoints();
app.MapUserEndpoints();
app.MapAuthEndpoints();
app.MapHealthChecks("/health");

app.Run();

// ❌ Wrong: flat Program.cs — unnavigable at scale
// All 200 endpoints registered inline here with no structure
app.MapGet("/api/messages/{id}", async (Guid id, IMessageService svc, CancellationToken ct) =>
    await svc.GetByIdAsync(id, ct));
app.MapGet("/api/conversations/{id}", async (Guid id, IConversationService svc, CancellationToken ct) =>
    await svc.GetByIdAsync(id, ct));
// ... 198 more inline lambdas — impossible to navigate, review, or test
```

## The Trap

```csharp
// A senior developer correctly organises endpoints into domain groups.
// TypedResults throughout. Group-level filters. Ships.
// The trap: dependency injection lifetime mismatch in endpoint delegates.

// Minimal API endpoint delegates resolve services from the DI container per-request.
// BUT: if you capture a Scoped service in a closure (lambda) during startup,
// that service is captured from the ROOT scope — a Singleton-lifetime instance.
// This is the same Captive Dependency problem as with MediatR behaviours.

// ❌ Wrong: capturing scoped service at startup
var messageService = app.Services.GetRequiredService<IMessageService>(); // Root scope!
app.MapGet("/messages/{id}", async (Guid id, CancellationToken ct) =>
    await messageService.GetByIdAsync(id, ct)); // Same instance for ALL requests — data leak

// ✅ Correct: inject via parameter — framework resolves from request scope
app.MapGet("/messages/{id}", async (
    Guid id,
    IMessageService messageService, // Resolved fresh per request ✅
    CancellationToken ct) =>
    await messageService.GetByIdAsync(id, ct));

// ✅ Correct: static method references in groups — prevents accidental closure capture
// (as shown in MessageEndpoints above — GetMessages is a static method)
// Static methods CANNOT close over variables — making accidental capture impossible.
// Always make endpoint handlers static when using group registration.

// Verify with a Roslyn analyzer rule: endpoint delegates must be static methods,
// not instance methods or lambdas that could close over scoped services.
```

## The Exception
Complex endpoints requiring model binders for multipart form data (file uploads), `ActionFilter` composition, view rendering, or cookie output formatters belong in MVC controllers — not Minimal APIs. Minimal APIs do not support the full MVC filter pipeline and attempting to replicate it with endpoint filters creates a maintenance burden greater than the performance gain. Use Minimal APIs for JSON API endpoints. Use MVC controllers for file upload, form handling, views, and complex filter composition.

## Before You Merge
- Are endpoint delegates declared as `static` methods — preventing accidental closure capture of Scoped services?
- Are all endpoint parameters injected via the method signature — not resolved from `app.Services` at startup?
- Are `TypedResults` used throughout — not `IResult` or `Results.Ok()` without type parameters?
- Is every endpoint group registered with `.WithTags()` and `.WithOpenApi()` — so Swagger categorises them correctly?
- Are group-level auth, rate limiting, and output caching policies applied at the `MapGroup()` level — not repeated per endpoint?
