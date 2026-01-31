# Effects Usage

How to use `effect` for side-effects, subscriptions, and cleanup in signal-based components.

## Core Concepts

- `effect(fn)` runs `fn` whenever its signal dependencies change.
- Effects must be side-effecting and may register cleanup logic by returning a function.
- Keep effects scoped and avoid expensive synchronous work inside them.

## Best Practices

### Use `effect` for logging and light subscriptions

```typescript
// ✅ DO
import {signal, effect} from '@angular/core';
const count = signal(0);
effect(() => console.log('count changed', count()));

// ❌ DON'T
// Poll signals with setInterval instead of using effect.
```

### Clean up resources inside effects

```typescript
// ✅ DO
effect((onCleanup) => {
  const id = setInterval(() => doWork(), 1000);
  onCleanup(() => clearInterval(id));
});

// ❌ DON'T
// Start timers or subscriptions and never clear them.
```

### Delegate heavy async work outside effects

```typescript
// ✅ DO
effect(() => {
  const q = heavyInput();
  scheduleHeavyWork(q).then(r => resultSignal.set(r));
});

// ❌ DON'T
// Perform synchronous heavy computation directly inside effect.
```

## Common Pitfalls

- **Pitfall:** Creating long-lived subscriptions inside effects without cleanup.
  - **Solution:** Always use the provided cleanup callback or `DestroyRef` in components.
- **Pitfall:** Returning values from effects expecting them to be used.
  - **Solution:** Effects cannot be used as computed values; use `computed` for derived state.

## Quick Reference

| Pattern | Use When | Avoid When |
|--------:|:---------|:-----------|
| `effect` | Side-effects on signal change | Deriving values (use `computed`) |
| Cleanup callback | Timers/subscriptions | Leaky resources |

## Related Topics

- [Signals: Core Concepts](core-concepts.md)
- [Preventing Memory Leaks](preventing-memory-leaks.md)
