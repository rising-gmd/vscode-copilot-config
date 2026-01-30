---
name: .NET Core + C# Standards
description: C# conventions, SOLID principles, async/await patterns, and dependency injection guidance.
applyTo: "**/*.{cs,csproj}"
---

# .NET Core + C# Instruction

## Conventions
- Use PascalCase for types and members. Use `_camelCase` for private fields.
- File and folder organization: `Controllers/`, `Services/`, `Repositories/`, `Models/`, `DTOs/`.

## Architecture & SOLID
- Favor dependency inversion; use constructor injection for services.
- Keep controllers thin: orchestration only; business logic belongs in services.

## Async/Await
- Use `async` suffix for asynchronous methods when appropriate (e.g., `GetUserAsync`).
- Avoid `async void`; prefer `Task`/`Task<T>` and `ConfigureAwait(false)` for library code.

## DI and Configuration
- Register services with proper lifetimes: `Scoped` for request-scoped, `Singleton` for long-lived stateless services, `Transient` for lightweight short-lived.

## Error Handling
- Use custom exception types and map them in a global exception middleware to standardized API error responses.

## Testing & Mocks
- Prefer xUnit, use `WebApplicationFactory<TEntryPoint>` for integration tests, and `Moq` for mocking dependencies.

## Examples & References
- Templates: see [../skills/dotnet-architecture/SKILL.md](../skills/dotnet-architecture/SKILL.md) and `controller-template.cs`.
