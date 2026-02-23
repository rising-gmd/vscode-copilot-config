# Options Pattern
> Verified against: .NET 9 | C# 13 | Microsoft.Extensions.Options 9.x
> Last reviewed: 2026-02-22

## The Law
Bind every configuration section to a strongly-typed options class with `ValidateDataAnnotations()` and `ValidateOnStart()` — never inject `IConfiguration` directly into application services or access config values by magic string keys.

## Why This Kills You At Scale
An `IConfiguration["Jwt:Secret"]` magic string scattered across 12 services fails silently when the key is missing — returns null, which then causes a `NullReferenceException` or `ArgumentNullException` at the first request that triggers the code path. At 100k users, a misconfigured deployment key (typo in environment variable name, missing Key Vault secret) causes random 500 errors for the subset of requests that hit the affected code path. With `ValidateOnStart()`, the app refuses to start — you find out in deployment, not in production traffic.

## The Pattern

```csharp
#nullable enable
using System.ComponentModel.DataAnnotations;
using Microsoft.Extensions.Options;

// ✅ Correct: strongly-typed options class with validation attributes
public sealed class JwtSettings
{
    public const string SectionName = "Jwt";

    [Required(AllowEmptyStrings = false)]
    [MinLength(32, ErrorMessage = "JWT secret must be at least 32 characters")]
    public string Secret { get; init; } = string.Empty;

    [Required(AllowEmptyStrings = false)]
    public string Issuer { get; init; } = string.Empty;

    [Required(AllowEmptyStrings = false)]
    public string Audience { get; init; } = string.Empty;

    [Range(1, 60, ErrorMessage = "Access token expiry must be between 1 and 60 minutes")]
    public double AccessTokenExpiryMinutes { get; init; } = 15;

    [Range(1, 365, ErrorMessage = "Refresh token expiry must be between 1 and 365 days")]
    public double RefreshTokenExpiryDays { get; init; } = 30;
}

public sealed class EmailSettings
{
    public const string SectionName = "Email";

    [Required]
    public string SmtpHost { get; init; } = string.Empty;

    [Range(1, 65535)]
    public int SmtpPort { get; init; } = 587;

    [Required]
    [EmailAddress]
    public string FromAddress { get; init; } = string.Empty;

    [Required]
    public string FromName { get; init; } = string.Empty;
}

public sealed class RedisSettings
{
    public const string SectionName = "Redis";

    [Required]
    public string ConnectionString { get; init; } = string.Empty;

    [Range(0, 15)]
    public int Database { get; init; } = 0;

    [Required]
    public string KeyPrefix { get; init; } = "app";
}

// ✅ Correct: registration in Program.cs — validate at startup, not at first use
builder.Services
    .AddOptions<JwtSettings>()
    .Bind(builder.Configuration.GetSection(JwtSettings.SectionName))
    .ValidateDataAnnotations()  // Runs [Required], [MinLength] etc.
    .ValidateOnStart();         // Throws at startup if invalid — not at runtime

builder.Services
    .AddOptions<EmailSettings>()
    .Bind(builder.Configuration.GetSection(EmailSettings.SectionName))
    .ValidateDataAnnotations()
    .ValidateOnStart();

builder.Services
    .AddOptions<RedisSettings>()
    .Bind(builder.Configuration.GetSection(RedisSettings.SectionName))
    .ValidateDataAnnotations()
    .ValidateOnStart();

// ✅ Correct: inject IOptions<T> for static config, IOptionsMonitor<T> for hot-reload
public sealed class JwtTokenService(IOptions<JwtSettings> options)
{
    // IOptions<T> — value is fixed at startup, no overhead per access
    private readonly JwtSettings _settings = options.Value;
    private readonly byte[] _keyBytes = Encoding.UTF8.GetBytes(options.Value.Secret);

    public string GenerateAccessToken(Guid userId, string email, string username)
    {
        // Use _settings.AccessTokenExpiryMinutes — not a magic string
        var expiry = DateTime.UtcNow.AddMinutes(_settings.AccessTokenExpiryMinutes);
        // ... generate token
        return string.Empty;
    }
}

// ✅ Correct: IOptionsMonitor<T> for configuration that changes at runtime (feature flags)
public sealed class FeatureFlagService(IOptionsMonitor<FeatureFlags> monitor)
{
    public bool IsEnabled(string flag)
    {
        // IOptionsMonitor reloads when appsettings.json changes — no restart needed
        return monitor.CurrentValue.EnabledFlags.Contains(flag);
    }
}

// ✅ Correct: custom validation beyond DataAnnotations
public sealed class JwtSettingsValidator : IValidateOptions<JwtSettings>
{
    public ValidateOptionsResult Validate(string? name, JwtSettings options)
    {
        if (options.Issuer.Equals(options.Audience, StringComparison.OrdinalIgnoreCase))
            return ValidateOptionsResult.Fail(
                "JWT Issuer and Audience must be different values");

        if (options.AccessTokenExpiryMinutes > options.RefreshTokenExpiryDays * 24 * 60)
            return ValidateOptionsResult.Fail(
                "Access token expiry cannot exceed refresh token expiry");

        return ValidateOptionsResult.Success;
    }
}

// ✅ Register custom validator:
// builder.Services.AddSingleton<IValidateOptions<JwtSettings>, JwtSettingsValidator>();

// ❌ Wrong: magic string config access — fails silently on misconfiguration
public sealed class InsecureTokenService(IConfiguration config)
{
    public string GenerateToken()
    {
        var secret = config["Jwt:Secret"]; // null if key is missing — no error until first call
        var keyBytes = Encoding.UTF8.GetBytes(secret!); // NullReferenceException in production
        return string.Empty;
    }
}
```

## The Trap

```csharp
// A senior developer correctly uses IOptions<T> with ValidateOnStart.
// All config validated at startup. Ships.
// The trap: ValidateOnStart only validates options that have been ACCESSED.
// If no service injects IOptions<EmailSettings> during startup,
// EmailSettings is never validated — even with ValidateOnStart().

// This is a known EF/DI behavior: ValidateOnStart() works by triggering
// validation when the options are first resolved from the container.
// If nothing resolves EmailSettings during startup, validation never runs.
// The broken config ships silently.

// Fix: explicitly trigger validation for all critical options at startup
public static class OptionsValidationExtensions
{
    public static WebApplication ValidateCriticalOptions(this WebApplication app)
    {
        // Force resolution — triggers ValidateOnStart for all listed types
        _ = app.Services.GetRequiredService<IOptions<JwtSettings>>().Value;
        _ = app.Services.GetRequiredService<IOptions<EmailSettings>>().Value;
        _ = app.Services.GetRequiredService<IOptions<RedisSettings>>().Value;
        return app;
    }
}

// In Program.cs, after building the app:
// app.ValidateCriticalOptions(); // Throws immediately if any config is invalid
// app.Run();

// This guarantees validation runs regardless of which services are injected at startup.
// One line. Zero magic. Config errors surface in deployment, not production traffic.
```

## The Exception
Feature flags and A/B test configuration that change at runtime without restart should use `IOptionsMonitor<T>` instead of `IOptions<T>` — `IOptions<T>` is a snapshot taken at startup and never updates. However, `IOptionsMonitor<T>` has a per-access overhead because it checks for changes. Use `IOptions<T>` for infrastructure config (JWT keys, connection strings) that must not change at runtime, and `IOptionsMonitor<T>` for application-level toggles that legitimately need hot reload.

## Before You Merge
- Does every configuration section have a corresponding strongly-typed options class — no `IConfiguration["key"]` in application services?
- Does every options registration call both `ValidateDataAnnotations()` and `ValidateOnStart()`?
- Is `ValidateCriticalOptions()` called after `app.Build()` — forcing validation even for options not injected at startup?
- Are custom cross-field validation rules in an `IValidateOptions<T>` implementation — not in service constructors?
- Is `IOptionsMonitor<T>` used for hot-reload scenarios and `IOptions<T>` for static startup-time configuration?
