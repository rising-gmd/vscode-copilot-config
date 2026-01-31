# Validation Patterns

Reusable validation patterns for typed reactive forms.

## Core Concepts

- Keep validation rules pure and reusable (synchronous and asynchronous).
- Use typed `FormControl<T>` and return typed `ValidationErrors | null`.
- Compose validators and use `debounceTime` for async checks.

## Best Practices

### Write reusable synchronous validators

```typescript
// ✅ DO
import {FormControl, ValidationErrors} from '@angular/forms';
function minLength(min: number){ return (c: FormControl<string>): ValidationErrors | null => c.value.length >= min ? null : {minLength: {required: min}}; }

// ❌ DON'T
// Inline validator logic in multiple components.
```

### Use async validators for server checks with debounce

```typescript
// ✅ DO
function uniqueUsername(api: ApiService){ return (c: FormControl<string>) => api.checkUsername(c.value).pipe(map(exists => exists ? {unique: true} : null)); }

// ❌ DON'T
// Call server synchronously on every keystroke without debounce.
```

### Map validation errors to user-friendly messages centrally

```typescript
// ✅ DO
const messages = { required: 'Required', minLength: (p:any) => `Min ${p.required}` };

// ❌ DON'T
// Scatter error message logic across templates.
```

## Common Pitfalls

- **Pitfall:** Heavy async validation blocking UI.
  - **Solution:** Add debouncing and show intermediate state.
- **Pitfall:** Returning non-standard error shapes.
  - **Solution:** Return simple `{[key: string]: any}` shapes and document them.

## Quick Reference

| Pattern | Use When | Avoid When |
|--------:|:---------|:-----------|
| Sync validator fn | Local rules | Server-validated uniqueness |
| Async validator | Server checks | Fast client-side checks |

## Related Topics

- [Reactive Forms](reactive-forms.md)
- [Typed Forms](typed-forms.md)
