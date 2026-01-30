# GitHub Copilot Instructions — Enterprise Angular + .NET Core

This file provides global guidance for Copilot usage across an enterprise full-stack repository using Angular (TypeScript) on the frontend and .NET Core (C#) on the backend. It is intentionally prescriptive to keep agent outputs consistent, secure, and production-ready.

## Tech Stack Overview
- Frontend: Angular 15+ / TypeScript, SCSS/CSS, RxJS for async flows, NgRx (optional) for complex state.
- Backend: .NET Core 6+ / ASP.NET Core Web API, C# 10+, Entity Framework Core for persistence.
- Testing: Jasmine/Karma for Angular unit tests; xUnit for .NET; Playwright for end-to-end where required.
- CI/CD: GitHub Actions; container images via Docker; infrastructure as code (Terraform) optional.

## Global Coding Standards
- Naming:
  - TypeScript: PascalCase for component classes and interfaces (interfaces prefixed with `I`), camelCase for properties and local variables.
  - C#: PascalCase for types and public members, private fields use `_camelCase`.
- Files:
  - Angular: `kebab-case.component.ts`, matching `.html`, `.scss`, `.spec.ts` naming.
  - C#: `PascalCase.cs`, controllers under `Controllers/`, services under `Services/`.
- Formatting and linting:
  - TypeScript: ESLint with recommended Angular rules and workspace overrides. Use Prettier for formatting.
  - C#: StyleCop analyzer configured with `.editorconfig` and roslyn rules. Fail builds on style violations.
- Code comments: Use JSDoc for TypeScript public APIs and XML doc comments in C# for public types/methods.

## Error Handling Philosophy
- Prefer typed errors (custom error types) and centralized handling.
- Frontend: bubble errors to an `ErrorService` that decides user-facing messages, telemetry, and retry strategies.
- Backend: use global exception middleware to map exceptions to consistent API DTO error responses with `errorCode`, `message`, and optional `details` for internal telemetry only.
- Always log context and correlation IDs (trace identifiers) for cross-service tracing.

## Security Principles
- Principle of least privilege, defense-in-depth, and fail-safe defaults.
- Validate and sanitize all inputs server-side; use parameterized queries or EF Core to avoid SQL injection.
- Use strong typing and model binding to avoid over-posting.
- Secrets must never be checked into source; use environment variables / secret stores. Enforce scanning in CI.
- Authentication: prefer OAuth2/OpenID Connect; use role-based authorization and policy-driven checks in .NET.
- Frontend: avoid storing long-lived tokens in localStorage; use secure, httpOnly cookies when feasible.

## Performance Requirements
- Frontend: lazy-load feature modules, use OnPush change detection where possible, avoid unnecessary subscriptions, and use trackBy for *ngFor lists.
- Backend: prefer async I/O (async/await), use caching (in-memory, Redis) for expensive reads, and paginate endpoints. Enforce timeouts and circuit breakers for external calls.

## Testing Expectations
- Maintain a test pyramid: many fast unit tests, fewer integration tests, minimal E2E tests.
- Angular: aim for >=80% unit coverage per team agreement; focus on behavior and component contracts.
- .NET: unit tests for services and controllers; integration tests using `WebApplicationFactory` for realistic wiring and in-memory DB where appropriate.

## Documentation Standards
- Each feature module and API area must include a README with purpose, public API surface, example usage, and run/test instructions.
- API endpoints should have OpenAPI (Swagger) definitions; use XML comments in controllers and DTOs to enhance generated docs.

## Agent Behavior Guidelines for Copilot
- Prefer minimal, secure, and idiomatic code over clever one-liners.
- Include JSDoc/XML comments for newly added public functions or types.
- When creating templates, include configuration snippets for ESLint/StyleCop and tests.
- Reference this file in prompts for consistent style.

---

This file must remain plain Markdown (no YAML frontmatter).
