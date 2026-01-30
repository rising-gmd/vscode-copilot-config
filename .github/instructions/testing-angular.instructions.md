---
name: Testing for Angular
description: Guidelines for writing Jasmine/Karma unit tests, component TestBed configuration and service mocking
applyTo: "**/*.spec.ts"
---

# Testing - Angular

## Patterns
- Use Arrange-Act-Assert (AAA).
- Configure `TestBed` minimally; use `HttpClientTestingModule` for HTTP tests.
- Mock services with Jasmine spies or use lightweight test doubles.

## Component Tests
- Prefer shallow tests for isolated logic and integration-style TestBed tests for template + DI interactions.
- Use `fixture.detectChanges()` only when necessary; rely on Observables and `fakeAsync`/`tick` for async flows.

## Coverage
- Aim for 80% coverage at module level; prioritize critical business logic and public service APIs.

## Example
- See prompts and skill templates under `../prompts` and `../skills/testing-strategy/test-templates`.
