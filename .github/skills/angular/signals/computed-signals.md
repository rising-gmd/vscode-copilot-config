# Computed Signals

Using `computed` to derive values declaratively and efficiently.

## Core Concepts

- `computed(() => ...)` creates a lazily-evaluated derived signal that tracks dependencies.
- `computed` must be pure and synchronous; it should not perform side-effects.
- Cache invalidation is automatic: when underlying signals change, `computed` re-evaluates.

## Best Practices

### Keep `computed` pure and fast

```typescript
// ✅ DO
import {computed, signal} from '@angular/core';
const items = signal([1,2,3]);
const count = computed(() => items().length);

// ❌ DON'T
// Do not perform async or side-effect work inside computed.
```

### Compose computed signals for larger derived logic

```typescript
// ✅ DO
const a = signal(2);
const b = signal(3);
const sum = computed(() => a() + b());
const doubled = computed(() => sum() * 2);

// ❌ DON'T
// Duplicate logic instead of composing computed signals.
```

### Use `computed` for template bindings rather than methods

```html
<!-- ✅ DO -->
<div>{{ fullName() }}</div>

<!-- ❌ DON'T -->
<!-- Avoid calling component methods that compute on every change detection -->
<div>{{ fullNameMethod() }}</div>
```

## Common Pitfalls

- **Pitfall:** Heavy CPU inside `computed` causing UI jank.
  - **Solution:** Move heavy work to web worker or memoize outside computed and use `effect` to trigger.
- **Pitfall:** Trying to await inside `computed`.
  - **Solution:** Use `effect` + async service calls, store result in a signal.

## Quick Reference

| Pattern | Use When | Avoid When |
|--------:|:---------|:-----------|
| `computed` | Derived, synchronous values | Async or side-effect work |
| Compose `computed` | Complex derivations | Recomputing same logic in multiple places |

## Related Topics

- [Signal-based State](signal-based-state.md)
- [Signals: Core Concepts](core-concepts.md)
