---
name: Testing for .NET
description: xUnit/NUnit patterns, AAA pattern, mocking with Moq and integration testing guidance
applyTo: "**/*Tests.cs,**/Test*.cs"
---

# Testing - .NET

## Unit Tests
- Use xUnit for unit tests. Follow AAA: Arrange, Act, Assert.
- Use `Moq` for mocking dependencies and `FluentAssertions` for clear assertions.

## Integration Tests
- Use `WebApplicationFactory<TEntryPoint>` to spin up lightweight in-memory server tests.
- Use an in-memory provider for EF Core or test containers for realistic DB scenarios.

## Naming
- Test methods: `UnitOfWork_Condition_ExpectedResult` (e.g., `GetUserAsync_UserExists_ReturnsUser`).

## Coverage
- Aim for 80% on critical services and integration flows.
