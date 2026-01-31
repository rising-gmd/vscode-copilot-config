# Preventing Memory Leaks

Practical techniques to avoid memory leaks in signal-based Angular apps.

## Core Concepts

- Always unregister subscriptions, timers, and DOM listeners when components are destroyed.
- Use `DestroyRef` and effect cleanup callbacks to tie resource lifetime to component lifetime.
- Prefer signals and `effect` cleanup over manual global state where possible.

## Best Practices

### Use `DestroyRef` for cleanup

```typescript
// ✅ DO
import {DestroyRef, inject} from '@angular/core';
const destroyRef = inject(DestroyRef);
destroyRef.onDestroy(() => cleanup());

// ❌ DON'T
// Rely on global singletons without lifecycle hooks to clean them.
```

### Use effect cleanup for timers and subscriptions

```typescript
// ✅ DO
effect((onCleanup) => {
  const id = setInterval(() => tick(), 1000);
  onCleanup(() => clearInterval(id));
});

// ❌ DON'T
// Start intervals in constructors and never clear them.
```

### Unsubscribe or use testing helpers for RxJS subscriptions

```typescript
// ✅ DO
const sub = someObservable.subscribe();
onDestroy(() => sub.unsubscribe());

// ❌ DON'T
someObservable.subscribe(); // never unsubscribed
```

## Common Pitfalls

- **Pitfall:** Storing DOM callbacks that reference component closures.
  - **Solution:** Remove listeners in onDestroy or use `Renderer2` with proper cleanup.
- **Pitfall:** Effects holding onto large objects or arrays that never get released.
  - **Solution:** Use scoped state and clear references in cleanup.

## Quick Reference

| Pattern | Use When | Avoid When |
|--------:|:---------|:-----------|
| `DestroyRef` | Cleanup tied to component | Global singletons without lifecycle |
| effect cleanup | timers, DOM listeners | One-off quick actions |

## Related Topics

- [Effects Usage](effects-usage.md)
- [Component Testing](../testing/component-testing.md)
