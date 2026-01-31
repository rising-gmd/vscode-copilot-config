# Typed Requests

Patterns for strongly-typed HTTP requests and responses using Angular `HttpClient`.

## Core Concepts

- Use typed generics on `HttpClient` methods: `http.get<T>(...)`.
- Map network DTOs to domain models explicitly; validate or coerce fields.
- Use interceptors for cross-cutting concerns like auth headers and error normalization.

## Best Practices

### Always type your requests and responses

```typescript
// ✅ DO
interface UserDto { id: string; name: string }
this.http.get<UserDto>('/api/user/1').subscribe(user => console.log(user.name));

// ❌ DON'T
this.http.get('/api/user/1').subscribe((user: any) => console.log(user.name));
```

### Map DTOs into domain models before use

```typescript
// ✅ DO
function mapUser(dto: UserDto) { return { id: dto.id, fullName: dto.name.toUpperCase() }; }

// ❌ DON'T
// Use raw DTO fields across app without mapping/validation.
```

### Prefer `HttpClient` generics over `any`

```typescript
// ✅ DO
this.http.post<{token: string}>('/login', creds);

// ❌ DON'T
this.http.post('/login', creds).pipe(map(r => r['token']));
```

## Common Pitfalls

- **Pitfall:** Blindly trusting backend types.
  - **Solution:** Use runtime guards or transform responses and fail fast.
- **Pitfall:** Overusing `any` to silence TypeScript errors.
  - **Solution:** Create small DTO types and refine gradually.

## Quick Reference

| Pattern | Use When | Avoid When |
|--------:|:---------|:-----------|
| `http.get<T>` | You control or know DTO shape | Unknown third-party payloads |
| Map DTOs | Need domain shape | Quick debugging only |

## Related Topics

- [Interceptors](interceptors.md)
