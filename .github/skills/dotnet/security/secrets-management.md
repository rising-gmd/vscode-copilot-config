# Secrets Management
> Verified against: .NET 9 | C# 13 | Azure Key Vault | Microsoft.Extensions.Configuration 9.x
> Last reviewed: 2026-02-22

## The Law
Secrets never touch source control — not in appsettings.json, not in comments, not in test fixtures — use User Secrets in development and Azure Key Vault with Managed Identity in production.

## Why This Kills You At Scale
A connection string committed to a public GitHub repo in 2019 is still being scanned and exploited in 2024 — git history is permanent and public scanners index it within minutes of a push. At 100k users, a leaked DB connection string means every user's data is accessible to anyone with a browser and basic SQL knowledge, and you will not know until a security researcher or attacker tells you.

## The Pattern

```csharp
#nullable enable
using Azure.Identity;
using Azure.Security.KeyVault.Secrets;
using Microsoft.Extensions.Configuration;

// ✅ Correct: Program.cs — layered configuration, secrets override appsettings
var builder = WebApplication.CreateBuilder(args);

// Layer 1: appsettings.json — non-secret config only (connection string template, not value)
// Layer 2: appsettings.{Environment}.json — non-secret environment overrides
// Layer 3: User Secrets (development only) — local secrets, never committed
// Layer 4: Environment variables (CI/CD, containers) — injected at deploy time
// Layer 5: Azure Key Vault (production) — authoritative secret store

if (builder.Environment.IsProduction() || builder.Environment.IsStaging())
{
    var keyVaultUri = builder.Configuration["Azure:KeyVaultUri"]
        ?? throw new InvalidOperationException("Azure:KeyVaultUri not configured");

    // ✅ Correct: Managed Identity — no credentials in code, no rotation needed
    builder.Configuration.AddAzureKeyVault(
        new Uri(keyVaultUri),
        new DefaultAzureCredential());
}

// ✅ Correct: access secrets through IConfiguration — same code in all environments
var connectionString = builder.Configuration.GetConnectionString("DefaultConnection")
    ?? throw new InvalidOperationException("Connection string not configured");

// ✅ Correct: strongly typed settings — fail fast at startup if secret missing
builder.Services.AddOptions<JwtSettings>()
    .Bind(builder.Configuration.GetSection("Jwt"))
    .ValidateDataAnnotations()  // Validates [Required] attributes at startup
    .ValidateOnStart();         // Fail immediately, not on first use

// ✅ Correct: appsettings.json — placeholder shows structure, never value
// {
//   "ConnectionStrings": {
//     "DefaultConnection": "" // Set in User Secrets (dev) or Key Vault (prod)
//   },
//   "Jwt": {
//     "Issuer": "https://yourapp.com",   // Non-secret — ok in appsettings
//     "Audience": "https://yourapp.com", // Non-secret — ok in appsettings
//     "Secret": ""                        // Secret — NEVER put value here
//   }
// }

// ✅ Correct: User Secrets setup for development
// dotnet user-secrets init
// dotnet user-secrets set "ConnectionStrings:DefaultConnection" "Server=localhost;..."
// dotnet user-secrets set "Jwt:Secret" "your-local-dev-secret-min-32-chars"

// ❌ Wrong: secret in appsettings.json — committed to git forever
// {
//   "Jwt": {
//     "Secret": "MySuperSecretKey123!" // Now in git history permanently
//   }
// }

// ❌ Wrong: hardcoded in code — worse than appsettings, harder to rotate
public class HardcodedSecrets
{
    private const string JwtSecret = "MySuperSecretKey123!"; // Never
    private const string ConnString = "Server=prod.db.com;Password=abc123"; // Never
}
```

## The Trap

```csharp
// A senior developer sets up Key Vault correctly.
// DefaultAzureCredential works in production with Managed Identity.
// Works in CI/CD with environment variables.
// Developer clones repo on a new machine — Key Vault access fails in development.
// Developer copies the production secret into appsettings.Development.json "just temporarily".
// "Temporarily" is committed. Production secret is now in git history.

// This happens in every team. The fix is to make the fallback path obviously correct:

// In launchSettings.json (not committed if in .gitignore) or developer machine env vars:
// ASPNETCORE_ENVIRONMENT=Development
// Azure__KeyVaultUri=https://dev-keyvault.vault.azure.net/

// Or: use a SEPARATE dev Key Vault — developers have access, production vault is locked down
// Dev vault: developers can read/write, used in development
// Prod vault: only Managed Identity can read, no human has list/get permissions

// Document this in your README — if it is not documented, developers will find the wrong workaround.
// The README should say: "To run locally: dotnet user-secrets set ..."
// Not: "Copy the secret from the prod config" (which you will never write, but someone will do)
```

## The Exception
Non-secret configuration that varies by environment (feature flags, timeouts, URLs) belongs in appsettings.{Environment}.json and should be committed. The rule applies only to secrets — values that grant access to resources (connection strings, API keys, signing keys, certificates). If you are unsure whether a value is a secret, ask: "If this value leaked publicly, could someone access a system or impersonate users?" If yes, it is a secret.

## Before You Merge
- Does `appsettings.json` contain zero secret values — only structure with empty string placeholders?
- Is `.gitignore` excluding `appsettings.Development.json` if that file is used for local overrides?
- Does production use `DefaultAzureCredential` with Managed Identity — no client secrets in config?
- Does startup throw `InvalidOperationException` immediately if required secrets are missing — not null reference exceptions at runtime?
- Has `git log -p -- appsettings*.json` been run to confirm no secrets have ever been committed?
