# Reactive Forms

Practical patterns for building robust reactive forms using Angular APIs and typed signals.

## Core Concepts

- Prefer reactive forms for complex forms and validation logic.
- Use typed controls where possible and avoid `any` in form models.
- Keep validation rules declarative and reusable.

## Best Practices

### Define strongly-typed form models

```typescript
// ✅ DO
import {FormGroup, FormControl, Validators} from '@angular/forms';
interface Profile { name: string; age: number }
const profileForm = new FormGroup({
  name: new FormControl<string>('', {nonNullable: true}),
  age: new FormControl<number | null>(null)
});

// ❌ DON'T
const badForm = new FormGroup({ name: new FormControl('') }) as any;
```

### Use reusable validators and compose them

```typescript
// ✅ DO
function minAge(min: number) { return (c: FormControl<number>) => c.value! >= min ? null : {minAge: true}; }

// ❌ DON'T
// Inline complex validation repeatedly across components
```

### React to value changes with signals or observables, not polling

```typescript
// ✅ DO
profileForm.valueChanges.subscribe(v => console.log(v));

// ❌ DON'T
setInterval(() => checkForm(), 1000); // avoid polling
```

## Common Pitfalls

- **Pitfall:** Treating FormControl values as `any` and late-binding types.
  - **Solution:** Use generic `FormControl<T>` and `nonNullable` when appropriate.
- **Pitfall:** Heavy work in `valueChanges` subscribers without debounce.
  - **Solution:** Use `debounceTime` or other operators for frequent inputs.

## Quick Reference

| Pattern | Use When | Avoid When |
|--------:|:---------|:-----------|
| Typed `FormControl<T>` | Strong typing required | Quick prototypes only |
| `valueChanges` | React to form updates | Synchronous heavy work |

## Related Topics

- [Typed Forms](typed-forms.md)
- [Signals: Core Concepts](../signals/core-concepts.md)
