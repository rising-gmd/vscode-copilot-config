# Security Best Practices

Security is not optional. Every line of code must defend against threats. Build applications that are secure by design.

---

## Authentication & Authorization

### JWT Bearer Authentication

```csharp
// Program.cs
builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(options =>
    {
        options.TokenValidationParameters = new TokenValidationParameters
        {
            ValidateIssuer = true,
            ValidateAudience = true,
            ValidateLifetime = true,
            ValidateIssuerSigningKey = true,
            ValidIssuer = builder.Configuration["Jwt:Issuer"],
            ValidAudience = builder.Configuration["Jwt:Audience"],
            IssuerSigningKey = new SymmetricSecurityKey(
                Encoding.UTF8.GetBytes(builder.Configuration["Jwt:SecretKey"]!)),
            ClockSkew = TimeSpan.Zero // No grace period
        };
    });

app.UseAuthentication();
app.UseAuthorization();
```

### Policy-Based Authorization

```csharp
// DO - Policy-based authorization
builder.Services.AddAuthorization(options =>
{
    options.AddPolicy("RequireAdmin", policy =>
        policy.RequireRole("Admin"));

    options.AddPolicy("RequireEmailVerified", policy =>
        policy.RequireClaim("email_verified", "true"));

    options.AddPolicy("MinimumAge", policy =>
        policy.Requirements.Add(new MinimumAgeRequirement(18)));
});

// Custom requirement
public class MinimumAgeRequirement : IAuthorizationRequirement
{
    public int MinimumAge { get; }
    public MinimumAgeRequirement(int minimumAge) => MinimumAge = minimumAge;
}

public class MinimumAgeHandler : AuthorizationHandler<MinimumAgeRequirement>
{
    protected override Task HandleRequirementAsync(
        AuthorizationHandlerContext context,
        MinimumAgeRequirement requirement)
    {
        var dateOfBirth = context.User.FindFirst(c => c.Type == "date_of_birth")?.Value;
        if (DateTime.TryParse(dateOfBirth, out var dob))
        {
            var age = DateTime.Today.Year - dob.Year;
            if (age >= requirement.MinimumAge)
                context.Succeed(requirement);
        }
        return Task.CompletedTask;
    }
}

// Usage
[Authorize(Policy = "RequireAdmin")]
public async Task<IActionResult> DeleteUser(int id) { }

// Or with Minimal APIs
app.MapDelete("/users/{id}", DeleteUser)
    .RequireAuthorization("RequireAdmin");
```

---

## Secrets Management

### Never Hardcode Secrets

```csharp
// NEVER - Hardcoded secrets
var connectionString = "Server=prod.db;User=admin;Password=P@ssw0rd123";
var apiKey = "sk_live_abc123xyz789";

// DO - User Secrets (Development)
// Right-click project → Manage User Secrets
// stores in %APPDATA%\Microsoft\UserSecrets\<project-id>\secrets.json
{
  "ConnectionStrings": {
    "Default": "Server=localhost;Database=MyDb;Trusted_Connection=true"
  },
  "ExternalApi": {
    "ApiKey": "dev_key_123"
  }
}

// DO - Azure Key Vault (Production)
builder.Configuration.AddAzureKeyVault(
    new Uri(builder.Configuration["KeyVaultUrl"]!),
    new DefaultAzureCredential());

// DO - Environment Variables
var apiKey = builder.Configuration["ExternalApi:ApiKey"];
```

---

## Input Validation

### Validate All Inputs

```csharp
// DO - Server-side validation always
public record CreateUserRequest
{
    [Required]
    [EmailAddress]
    [StringLength(255)]
    public string Email { get; init; }

    [Required]
    [StringLength(100, MinimumLength = 8)]
    [RegularExpression(@"^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$",
        ErrorMessage = "Password must contain uppercase, lowercase, number, and special character")]
    public string Password { get; init; }
}

// FluentValidation (more powerful)
public class CreateUserRequestValidator : AbstractValidator<CreateUserRequest>
{
    public CreateUserRequestValidator()
    {
        RuleFor(x => x.Email)
            .NotEmpty()
            .EmailAddress()
            .MaximumLength(255);

        RuleFor(x => x.Password)
            .NotEmpty()
            .MinimumLength(8)
            .Matches(@"[A-Z]").WithMessage("Password must contain uppercase letter")
            .Matches(@"[a-z]").WithMessage("Password must contain lowercase letter")
            .Matches(@"\d").WithMessage("Password must contain number")
            .Matches(@"[@$!%*?&]").WithMessage("Password must contain special character");
    }
}
```

### Prevent SQL Injection

```csharp
// DO - Parameterized queries (EF Core handles this)
var users = await context.Users
    .Where(u => u.Email == email)
    .ToListAsync();

// DO - Parameterized with Dapper
var users = await connection.QueryAsync<User>(
    "SELECT * FROM Users WHERE Email = @Email",
    new { Email = email });

// NEVER - String concatenation
var users = await connection.QueryAsync<User>(
    $"SELECT * FROM Users WHERE Email = '{email}'"); // SQL INJECTION RISK
```

---

## XSS Prevention

### Encode Outputs

```csharp
// DO - Razor automatically encodes
<p>Welcome, @Model.UserName</p> <!-- Encoded automatically -->

// DO - For JavaScript contexts, use Json.Serialize
<script>
    var user = @Html.Raw(Json.Serialize(Model.User));
</script>

// NEVER - @Html.Raw with user input
<p>@Html.Raw(Model.UserInput)</p> <!-- XSS vulnerability -->
```

---

## CSRF Prevention

```csharp
// DO - Anti-forgery tokens for state-changing operations
builder.Services.AddAntiforgery(options =>
{
    options.HeaderName = "X-CSRF-TOKEN";
    options.Cookie.SecurePolicy = CookieSecurePolicy.Always;
    options.Cookie.SameSite = SameSiteMode.Strict;
});

// In Razor Pages
<form method="post">
    @Html.AntiForgeryToken()
    <!-- form fields -->
</form>

// In API with JavaScript
app.MapPost("/users", CreateUser)
    .RequireAntiforgery();
```

---

## HTTPS Enforcement

```csharp
// Program.cs
if (!app.Environment.IsDevelopment())
{
    app.UseHsts(); // HTTP Strict Transport Security
}

app.UseHttpsRedirection(); // Redirect HTTP to HTTPS

// Configure HSTS
builder.Services.AddHsts(options =>
{
    options.MaxAge = TimeSpan.FromDays(365);
    options.IncludeSubDomains = true;
    options.Preload = true;
});
```

---

## CORS

```csharp
// DO - Explicit origins, never AllowAnyOrigin with credentials
builder.Services.AddCors(options =>
{
    options.AddPolicy("ProductionPolicy", policy =>
    {
        policy.WithOrigins("https://myapp.com", "https://admin.myapp.com")
            .AllowAnyMethod()
            .AllowAnyHeader()
            .AllowCredentials(); // OK with specific origins
    });
});

app.UseCors("ProductionPolicy");

// NEVER - Security vulnerability
policy.AllowAnyOrigin().AllowCredentials(); // Won't work, throws exception
policy.SetIsOriginAllowed(_ => true).AllowCredentials(); // Effectively AllowAnyOrigin
```

---

## Password Hashing

```csharp
// DO - Use ASP.NET Core Identity's PasswordHasher
public class UserService
{
    private readonly IPasswordHasher<User> _passwordHasher;

    public UserService(IPasswordHasher<User> passwordHasher)
        => _passwordHasher = passwordHasher;

    public User CreateUser(string email, string password)
    {
        var user = new User { Email = email };
        user.PasswordHash = _passwordHasher.HashPassword(user, password);
        return user;
    }

    public bool VerifyPassword(User user, string password)
    {
        var result = _passwordHasher.VerifyHashedPassword(user, user.PasswordHash, password);
        return result == PasswordVerificationResult.Success;
    }
}

// NEVER - Plain text or weak hashing
user.Password = password; // Plain text
user.Password = SHA256.HashData(Encoding.UTF8.GetBytes(password)); // No salt
```

---

## Rate Limiting

```csharp
// Program.cs
builder.Services.AddRateLimiter(options =>
{
    // Per user/IP rate limiting
    options.AddFixedWindowLimiter("fixed", limiterOptions =>
    {
        limiterOptions.PermitLimit = 100;
        limiterOptions.Window = TimeSpan.FromMinutes(1);
        limiterOptions.QueueProcessingOrder = QueueProcessingOrder.OldestFirst;
        limiterOptions.QueueLimit = 10;
    });

    // Per endpoint concurrency limit
    options.AddConcurrencyLimiter("concurrent", limiterOptions =>
    {
        limiterOptions.PermitLimit = 50;
        limiterOptions.QueueProcessingOrder = QueueProcessingOrder.OldestFirst;
        limiterOptions.QueueLimit = 20;
    });

    options.OnRejected = async (context, ct) =>
    {
        context.HttpContext.Response.StatusCode = 429;
        await context.HttpContext.Response.WriteAsJsonAsync(
            new { error = "Too many requests" }, ct);
    };
});

app.UseRateLimiter();

// Apply to endpoints
app.MapPost("/users", CreateUser)
    .RequireRateLimiting("fixed");
```

---

## Sensitive Data Logging

```csharp
// DO - Structured logging without sensitive data
_logger.LogInformation("User {UserId} logged in from {IpAddress}",
    user.Id, httpContext.Connection.RemoteIpAddress);

// NEVER - Log passwords, tokens, PII
_logger.LogInformation("User {Email} logged in with password {Password}",
    user.Email, password); // SECURITY VIOLATION

// DO - Configure logging to exclude sensitive data
builder.Services.AddDbContext<ApplicationDbContext>(options =>
{
    options.UseSqlServer(connectionString)
        .EnableSensitiveDataLogging(false) // Never true in production
        .EnableDetailedErrors(false); // Never true in production
});
```

---

## Security Headers

```csharp
// DO - Security headers middleware
app.Use(async (context, next) =>
{
    context.Response.Headers.Append("X-Content-Type-Options", "nosniff");
    context.Response.Headers.Append("X-Frame-Options", "DENY");
    context.Response.Headers.Append("X-XSS-Protection", "1; mode=block");
    context.Response.Headers.Append("Referrer-Policy", "strict-origin-when-cross-origin");
    context.Response.Headers.Append(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'");
    
    await next();
});

// Or use NWebsec package
builder.Services.AddHsts(options =>
{
    options.MaxAge = TimeSpan.FromDays(365);
    options.IncludeSubDomains = true;
    options.Preload = true;
});
```

---

## Dependency Scanning

```yaml
# .github/workflows/security.yml
name: Security Scan

on: [push, pull_request]

jobs:
  security:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Run OWASP Dependency Check
        uses: dependency-check/Dependency-Check_Action@main
        with:
          project: 'MyApp'
          path: '.'
          format: 'HTML'
          
      - name: Run Snyk Security Scan
        uses: snyk/actions/dotnet@master
        env:
          SNYK_TOKEN: ${{ secrets.SNYK_TOKEN }}
```

---

## Checklist

- [ ] JWT tokens validated (issuer, audience, lifetime, signature)
- [ ] Policy-based authorization, not role strings
- [ ] Secrets in Azure Key Vault or User Secrets, never hardcoded
- [ ] All inputs validated server-side
- [ ] Parameterized queries (no string concatenation in SQL)
- [ ] Outputs encoded (Razor auto-encodes, verify JavaScript contexts)
- [ ] Anti-forgery tokens on state-changing operations
- [ ] HTTPS enforced with HSTS
- [ ] CORS configured explicitly (no AllowAnyOrigin with credentials)
- [ ] Passwords hashed with PasswordHasher (bcrypt/PBKDF2)
- [ ] Rate limiting on public endpoints
- [ ] Sensitive data never logged
- [ ] Security headers set (X-Content-Type-Options, X-Frame-Options, CSP)
- [ ] Dependency scanning in CI/CD pipeline

---

**Security is a process, not a checklist. Threat model, review, and test continuously.**