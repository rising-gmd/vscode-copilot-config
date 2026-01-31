# Service Testing

Guidance for unit-testing services, mocking dependencies, and using `HttpClientTestingModule`.

## Core Concepts

- Test services in isolation by injecting mocks and using `TestBed` to configure providers.
- Use `HttpClientTestingModule` to intercept HTTP calls in unit tests.
- Assert observable behavior deterministically using marble tests or synchronous helpers.

## Best Practices

### Provide test doubles for dependencies

```typescript
// ✅ DO
TestBed.configureTestingModule({ providers: [{ provide: ApiService, useValue: mockApi }] });

// ❌ DON'T
// Call real APIs during unit tests.
```

### Use `HttpClientTestingModule` for HTTP assertions

```typescript
// ✅ DO
import {HttpTestingController, HttpClientTestingModule} from '@angular/common/http/testing';
TestBed.configureTestingModule({ imports: [HttpClientTestingModule] });

// ❌ DON'T
// Use real HttpClient pointing at network endpoints.
```

### Keep tests fast and deterministic (avoid timers without control)

```typescript
// ✅ DO
// Use fakeAsync and tick when testing timers

// ❌ DON'T
// Rely on setTimeout with real delays in unit tests
```

## Common Pitfalls

- **Pitfall:** Mixing integration network tests with unit tests.
  - **Solution:** Separate integration/E2E from unit tests and control environments.
- **Pitfall:** Uncleaned HttpTestingController expectations.
  - **Solution:** Call `httpMock.verify()` in `afterEach`.

## Quick Reference

| Pattern | Use When | Avoid When |
|--------:|:---------|:-----------|
| `HttpClientTestingModule` | Service HTTP behavior | End-to-end integration tests |
| Mock providers | Replace external deps | Full integration wiring |

## Related Topics

- [Component Testing](component-testing.md)
