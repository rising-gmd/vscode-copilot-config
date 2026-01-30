---
name: Angular + TypeScript Standards
description: Coding standards, component structure, RxJS patterns, and state management guidance for Angular projects.
applyTo: "**/*.{ts,tsx,html,scss,css}"
---

# Angular + TypeScript Instruction

## Component Structure
- Feature modules should be lazy-loaded and logically grouped by domain.
- Components: keep dumb/presentational components separate from smart/container components.
- Inputs/Outputs: prefer strongly typed interfaces and avoid `any`.
- Naming: `PascalCase` class names, `kebab-case` filenames: `user-profile.component.ts`.

## RxJS Patterns
- Prefer pipeable operators and use the `takeUntil` pattern with `ngOnDestroy` for teardown.
- Prefer higher-order mapping (`switchMap`) for dependent requests and `mergeMap` for parallel.
- Avoid nested subscriptions; prefer `combineLatest` / `forkJoin` when aggregating observables.

## State Management
- Use component-level Observables for local state; consider NgRx or Akita for complex global state.
- Keep selectors memoized and pure; avoid storing derived state if it can be computed.

## Typing & Interfaces
- Prefix interfaces with `I` for shared/public DTOs (e.g., `IUser`), but not for local-only interfaces.
- Use discriminated unions for union types to improve exhaustiveness checking.

## Error Handling
- Use a centralized `ErrorService` to translate errors for UI and telemetry.
- Network requests should surface typed error objects with an optional `retry` semantic.

## Testing
- Provide patterns for TestBed configuration, mocking services, and component harnesses.

## Examples & References
- See [../skills/angular-patterns/SKILL.md](../skills/angular-patterns/SKILL.md) for templates and examples.
