# Signals: Core Concepts

Short overview of Angular Signals and why they are the recommended reactivity primitive.

## Core Concepts

- Signals are first-class reactive primitives: `signal`, `computed`, `effect`.
- Signals are read by calling them as functions (e.g., `count()`), and written with `set`/`update` or `signal()` setters.
- Signals are recorded at compile-time for inputs and are preferred over constructor injection for DI in many cases (`inject`).

## Best Practices

### Prefer signals for local component state
Use signals for component-local mutable state instead of plain properties.

```typescript
// ✅ DO
import {signal} from '@angular/core';
export class Counter {
  count = signal(0);
  increment() { this.count.set(this.count() + 1); }
}

// ❌ DON'T
export class CounterBad {
  count = 0;
  increment() { this.count += 1; }
}
```

### Use `computed` for derived values

```typescript
// ✅ DO
import {computed, signal} from '@angular/core';
const a = signal(2);
const b = signal(3);
const sum = computed(() => a() + b());

// ❌ DON'T
// Recompute manually or store duplicated derived state.
```

### Use `effect` for side-effects (subscriptions, logging)

```typescript
// ✅ DO
import {effect, signal} from '@angular/core';
const s = signal(0);
effect(() => console.log('value', s()));

// ❌ DON'T
// Imperative setInterval to poll signal values instead of reactive effect.
```

## Common Pitfalls

- **Pitfall:** Using signals but mutating nested objects directly.
  - **Solution:** Use immutable updates or replace whole object signals.
- **Pitfall:** Heavy synchronous work inside `computed` or `effect`.
  - **Solution:** Keep `computed` pure and light; move expensive work off main thread or into async flows.

## Quick Reference

| Pattern | Use When | Avoid When |
|--------:|:---------|:-----------|
| `signal` | Local mutable state | You need global shared state without wrapper |
| `computed` | Derived values | Side-effects or heavy CPU work |
| `effect` | Run side-effects on changes | Trying to return values from effect |

## Related Topics

- [Signal-based State](signal-based-state.md)
- [Computed Signals](computed-signals.md)
