# ASP.NET Core Web API Best Practices

Build production-grade REST APIs with .NET 10. Every endpoint must be fast, secure, and well-documented.

---

## API Structure

### Minimal APIs (Preferred for .NET 10)

```csharp
// DO - Group endpoints by feature
app.MapGroup("/api/users")
    .MapUserEndpoints()
    .RequireAuthorization();

// In separate file: UserEndpoints.cs
public static class UserEndpoints
{
    public static RouteGroupBuilder MapUserEndpoints(this RouteGroupBuilder group)
    {
        group.MapGet("/", GetUsers)
            .Produces<List<UserDto>>(200)
            .ProducesProblem(401);

        group.MapPost("/", CreateUser)
            .Produces<UserDto>(201)
            .ProducesValidationProblem();

        return group;
    }

    private static async Task<Results<Ok<List<UserDto>>, UnauthorizedHttpResult>> GetUsers(
        IUserService userService,
        CancellationToken ct)
    {
        var users = await userService.GetAllAsync(ct);
        return TypedResults.Ok(users);
    }
}
```

### Controllers (When Needed)

```csharp
[ApiController]
[Route("api/[controller]")]
[Produces("application/json")]
public class UsersController : ControllerBase
{
    private readonly IUserService _userService;

    public UsersController(IUserService userService) => _userService = userService;

    [HttpGet]
    [ProducesResponseType(typeof(List<UserDto>), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status401Unauthorized)]
    public async Task<ActionResult<List<UserDto>>> GetUsers(CancellationToken ct)
    {
        var users = await _userService.GetAllAsync(ct);
        return Ok(users);
    }

    [HttpPost]
    [ProducesResponseType(typeof(UserDto), StatusCodes.Status201Created)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    public async Task<ActionResult<UserDto>> CreateUser(
        CreateUserRequest request,
        CancellationToken ct)
    {
        var user = await _userService.CreateAsync(request, ct);
        return CreatedAtAction(nameof(GetUser), new { id = user.Id }, user);
    }
}
```

---

## DTOs — Never Expose Entities

```csharp
// DO - Use records for DTOs
public record UserDto(int Id, string Email, string FirstName, string LastName);

public record CreateUserRequest(
    [Required] string Email,
    [Required] string FirstName,
    [Required] string LastName);

// AVOID - Returning domain entities
public User GetUser(int id) => _context.Users.Find(id); // Exposes internal structure
```

---

## Validation

### FluentValidation (Recommended)

```csharp
public class CreateUserRequestValidator : AbstractValidator<CreateUserRequest>
{
    public CreateUserRequestValidator()
    {
        RuleFor(x => x.Email)
            .NotEmpty()
            .EmailAddress()
            .MaximumLength(255);

        RuleFor(x => x.FirstName)
            .NotEmpty()
            .MaximumLength(100);
    }
}

// Register in Program.cs
builder.Services.AddValidatorsFromAssemblyContaining<CreateUserRequestValidator>();

// With MediatR pipeline
builder.Services.AddTransient(typeof(IPipelineBehavior<,>), typeof(ValidationBehavior<,>));
```

### Data Annotations (Built-in)

```csharp
public record CreateUserRequest
{
    [Required]
    [EmailAddress]
    [StringLength(255)]
    public string Email { get; init; }

    [Required]
    [StringLength(100, MinimumLength = 2)]
    public string FirstName { get; init; }
}
```

---

## Error Handling

### ProblemDetails (RFC 9457)

```csharp
// DO - Return ProblemDetails for errors
app.UseExceptionHandler(exceptionHandlerApp =>
{
    exceptionHandlerApp.Run(async context =>
    {
        var exception = context.Features.Get<IExceptionHandlerFeature>()?.Error;
        var problemDetails = new ProblemDetails
        {
            Status = StatusCodes.Status500InternalServerError,
            Title = "An error occurred",
            Type = "https://tools.ietf.org/html/rfc7231#section-6.6.1",
            Instance = context.Request.Path
        };

        if (exception is ValidationException validationEx)
        {
            problemDetails.Status = StatusCodes.Status400BadRequest;
            problemDetails.Title = "Validation failed";
            problemDetails.Extensions["errors"] = validationEx.Errors;
        }

        context.Response.StatusCode = problemDetails.Status.Value;
        await context.Response.WriteAsJsonAsync(problemDetails);
    });
});

// Don't expose stack traces in production
builder.Services.AddProblemDetails(options =>
{
    options.CustomizeProblemDetails = context =>
    {
        context.ProblemDetails.Extensions["traceId"] = context.HttpContext.TraceIdentifier;
    };
});
```

---

## Response Caching

```csharp
// Program.cs
builder.Services.AddResponseCaching();
app.UseResponseCaching();

// On endpoint/controller
[ResponseCache(Duration = 60, VaryByQueryKeys = new[] { "page", "pageSize" })]
[HttpGet]
public async Task<ActionResult<List<ProductDto>>> GetProducts(int page, int pageSize)
{
    // Cache for 60 seconds, vary by pagination parameters
}

// Or with Minimal APIs
app.MapGet("/products", GetProducts)
    .CacheOutput(policy => policy.Expire(TimeSpan.FromMinutes(1)));
```

---

## Rate Limiting

```csharp
// Program.cs - .NET 10
builder.Services.AddRateLimiter(options =>
{
    options.GlobalLimiter = PartitionedRateLimiter.Create<HttpContext, string>(context =>
        RateLimitPartition.GetFixedWindowLimiter(
            partitionKey: context.User.Identity?.Name ?? context.Request.Headers.Host.ToString(),
            factory: partition => new FixedWindowRateLimiterOptions
            {
                AutoReplenishment = true,
                PermitLimit = 100,
                Window = TimeSpan.FromMinutes(1)
            }));

    options.OnRejected = async (context, ct) =>
    {
        context.HttpContext.Response.StatusCode = 429;
        await context.HttpContext.Response.WriteAsync("Too many requests", ct);
    };
});

app.UseRateLimiter();

// Apply to endpoints
app.MapGet("/api/products", GetProducts)
    .RequireRateLimiting("fixed");
```

---

## Versioning

```csharp
// DO - URL versioning (clearest for clients)
app.MapGroup("/api/v1/users").MapUserEndpointsV1();
app.MapGroup("/api/v2/users").MapUserEndpointsV2();

// OR header-based
builder.Services.AddApiVersioning(options =>
{
    options.DefaultApiVersion = new ApiVersion(1, 0);
    options.AssumeDefaultVersionWhenUnspecified = true;
    options.ReportApiVersions = true;
    options.ApiVersionReader = new HeaderApiVersionReader("api-version");
});
```

---

## OpenAPI / Swagger

```csharp
// .NET 10 - Use AddOpenApi (replaces Swashbuckle)
builder.Services.AddOpenApi();

app.MapOpenApi(); // Exposes /openapi/v1.json

if (app.Environment.IsDevelopment())
{
    app.MapScalarApiReference(); // Modern Swagger UI alternative
}

// Document endpoints
app.MapPost("/users", CreateUser)
    .WithSummary("Create a new user")
    .WithDescription("Creates a user with the provided details")
    .Produces<UserDto>(201)
    .ProducesValidationProblem();
```

---

## Pagination

```csharp
// DO - Always paginate lists
public record PagedResult<T>(List<T> Items, int TotalCount, int Page, int PageSize)
{
    public int TotalPages => (int)Math.Ceiling(TotalCount / (double)PageSize);
    public bool HasNext => Page < TotalPages;
    public bool HasPrevious => Page > 1;
}

[HttpGet]
public async Task<ActionResult<PagedResult<UserDto>>> GetUsers(
    [FromQuery] int page = 1,
    [FromQuery] int pageSize = 20,
    CancellationToken ct = default)
{
    if (pageSize > 100) pageSize = 100; // Prevent abuse

    var query = _context.Users.AsNoTracking();
    var total = await query.CountAsync(ct);
    var users = await query
        .OrderByDescending(u => u.CreatedDate)
        .Skip((page - 1) * pageSize)
        .Take(pageSize)
        .ProjectTo<UserDto>(_mapper.ConfigurationProvider)
        .ToListAsync(ct);

    return Ok(new PagedResult<UserDto>(users, total, page, pageSize));
}
```

---

## Async All the Way

```csharp
// DO - Async everywhere
public async Task<ActionResult<UserDto>> GetUser(int id, CancellationToken ct)
{
    var user = await _userService.GetByIdAsync(id, ct);
    return user is null ? NotFound() : Ok(user);
}

// NEVER - Blocking on async code
public ActionResult<UserDto> GetUser(int id)
{
    var user = _userService.GetByIdAsync(id, default).Result; // Deadlock risk
    return Ok(user);
}
```

---

## Compression

```csharp
// Program.cs
builder.Services.AddResponseCompression(options =>
{
    options.EnableForHttps = true;
    options.Providers.Add<BrotliCompressionProvider>();
    options.Providers.Add<GzipCompressionProvider>();
});

builder.Services.Configure<BrotliCompressionProviderOptions>(options =>
{
    options.Level = CompressionLevel.Fastest;
});

app.UseResponseCompression();
```

---

## CORS

```csharp
// DO - Configure CORS explicitly
builder.Services.AddCors(options =>
{
    options.AddPolicy("AllowSpecificOrigins", policy =>
    {
        policy.WithOrigins("https://myapp.com", "https://admin.myapp.com")
            .AllowAnyMethod()
            .AllowAnyHeader()
            .AllowCredentials();
    });
});

app.UseCors("AllowSpecificOrigins");

// NEVER - Allow any origin with credentials
policy.AllowAnyOrigin().AllowCredentials(); // Security vulnerability
```

---

## Checklist

- [ ] DTOs for all requests/responses (no entities exposed)
- [ ] Validation with FluentValidation or DataAnnotations
- [ ] ProblemDetails for error responses
- [ ] All endpoints async with `CancellationToken`
- [ ] Rate limiting configured
- [ ] Response caching where appropriate
- [ ] OpenAPI documentation complete
- [ ] Pagination on all list endpoints
- [ ] CORS configured explicitly (no AllowAnyOrigin with credentials)
- [ ] Compression enabled (Brotli/Gzip)
- [ ] API versioning strategy in place
- [ ] `[ProducesResponseType]` on all actions

---

**Every endpoint is a contract. Document it, version it, secure it.**