# Typed Forms

How to adopt TypeScript-first typed forms for safer form handling.

## Core Concepts

- Use `FormControl<T>` and `FormGroup<{...}>` generics to model form shape.
- Prefer `nonNullable` option to avoid unnecessary `null`/`undefined` unions.
- Map form models to DTOs with explicit transforms; avoid `any`.

## Best Practices

### Use generics for controls and groups

```typescript
// ✅ DO
import {FormGroup, FormControl} from '@angular/forms';
type Profile = {name: string; age: number | null};
const profile = new FormGroup<{name: FormControl<string>, age: FormControl<number | null>}>(
  { name: new FormControl('', {nonNullable: true}), age: new FormControl(null) }
);

// ❌ DON'T
const bad = new FormGroup({ name: new FormControl('') }) as unknown as FormGroup<Profile>;
```

### Convert form values to DTOs explicitly

```typescript
// ✅ DO
function toDto(form: FormGroup<{name: FormControl<string>, age: FormControl<number | null>}>) {
  return { name: form.controls.name.value, age: form.controls.age.value } as Profile;
}

// ❌ DON'T
// Rely on `form.value` with `any` cast.
```

### Use validators with typed controls

```typescript
// ✅ DO
profile.controls.name.setValidators([Validators.required]);

// ❌ DON'T
// Skip validators or leave types unchecked.
```

## Common Pitfalls

- **Pitfall:** Casting `FormGroup` to a typed shape without matching structure.
  - **Solution:** Build the group with explicit typed controls.
- **Pitfall:** Using `any` for form values when sending to APIs.
  - **Solution:** Map to a strictly-typed DTO function.

## Quick Reference

| Pattern | Use When | Avoid When |
|--------:|:---------|:-----------|
| `FormControl<T>` | Strong typing required | Prototypes or throwaway forms |
| `nonNullable` | Field must always have value | Field legitimately optional |

## Related Topics

- [Reactive Forms](reactive-forms.md)
