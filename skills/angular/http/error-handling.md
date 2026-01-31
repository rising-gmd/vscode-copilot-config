# HTTP Error Handling

Patterns to normalize and handle HTTP errors consistently across the app.

## Core Concepts

- Normalize backend errors to a consistent shape early (interceptor or service layer).
- Use typed error DTOs and `catchError` to map to domain-level errors.
- Surface actionable messages to users; log telemetry for debugging.

## Best Practices

### Map backend errors to a known shape

```typescript
// ✅ DO
this.http.get<User>('/api/user').pipe(
  catchError(err => throwError(() => mapToAppError(err)))
);

// ❌ DON'T
// Let varied backend error shapes leak into UI code.
```

### Use an error interceptor to centralize logic

```typescript
// ✅ DO
// Interceptor inspects response status and transforms payload into {errorCode, message}

// ❌ DON'T
// Duplicate error handling in every service method.
```

### Fail fast on unexpected response shapes

```typescript
// ✅ DO
function assertUser(dto: any): User { if (!dto?.id) throw new Error('Invalid user'); return dto as User; }

// ❌ DON'T
// Assume DTO properties exist without checks.
```

## Common Pitfalls

- **Pitfall:** Swallowing errors and returning undefined.
  - **Solution:** Always propagate or map errors; provide default UI-friendly fallbacks.
- **Pitfall:** Showing raw backend messages to users.
  - **Solution:** Map to localized, safe messages and log raw details to telemetry only.

## Quick Reference

| Pattern | Use When | Avoid When |
|--------:|:---------|:-----------|
| Interceptor mapping | Global error normalization | Highly-specialized per-call handling |
| `catchError` mapping | Local mapping to domain type | Swallowing errors silently |

## Related Topics

- [Interceptors](interceptors.md)
- [Typed Requests](typed-requests.md)
