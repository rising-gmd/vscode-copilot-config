# Interceptors

Practical guidance for `HttpInterceptor` patterns: auth, retries, and error normalization.

## Core Concepts

- Interceptors run for each HTTP request and can mutate requests/responses or handle errors.
- Keep interceptors small and single-purpose (auth, logging, error mapping).
- Register interceptors in the provider chain with care for ordering.

## Best Practices

### Add authorization header in a dedicated interceptor

```typescript
// ✅ DO
import {Injectable} from '@angular/core';
import {HttpInterceptor, HttpRequest, HttpHandler} from '@angular/common/http';
@Injectable()
export class AuthInterceptor implements HttpInterceptor {
  intercept(req: HttpRequest<any>, next: HttpHandler) {
    const token = 'token-value';
    const authReq = req.clone({ setHeaders: { Authorization: `Bearer ${token}` } });
    return next.handle(authReq);
  }
}

// ❌ DON'T
// Mutate global headers ad-hoc in services; centralize in interceptor.
```

### Normalize errors to a consistent shape

```typescript
// ✅ DO
// Interceptor maps API errors to {errorCode, message}

// ❌ DON'T
// Let diverse backends return inconsistent shapes across app.
```

### Keep interceptors synchronous where possible; delegate complex logic

```typescript
// ✅ DO
// Perform token refresh logic in a small, tested helper service rather than bloating interceptor.

// ❌ DON'T
// Add large retry and scheduling logic inline in interceptor.
```

## Common Pitfalls

- **Pitfall:** Circular HTTP calls when interceptor calls services that use HttpClient.
  - **Solution:** Avoid injecting services that use HttpClient into interceptors, or design a minimal non-HTTP helper.
- **Pitfall:** Incorrect provider order leading to unexpected header ordering.
  - **Solution:** Document and test provider chain ordering.

## Quick Reference

| Pattern | Use When | Avoid When |
|--------:|:---------|:-----------|
| Auth interceptor | Attach auth headers | Small apps without auth |
| Error mapping | Multiple backends | Single-consistent API |

## Related Topics

- [Typed Requests](typed-requests.md)
