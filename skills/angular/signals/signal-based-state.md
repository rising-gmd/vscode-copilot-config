# Signal-based State

How to structure application-local and shared state using Angular Signals.

## Core Concepts

- Represent state as signals: `signal<T>(initial)` or `signal<T|undefined>()`.
- Share state via injectable services that expose signals, not plain mutable objects.
- Prefer passing signal instances to child components to retain reactivity and avoid copying.

## Best Practices

### Create a state service that exposes signals

```typescript
// ✅ DO
import {Injectable, signal} from '@angular/core';

@Injectable({providedIn: 'root'})
export class CounterState {
  private _count = signal(0);
  readonly count = this._count;
  increment() { this._count.update(v => v + 1); }
}

// ❌ DON'T
// Expose mutable primitives and mutate externally.
```

### Pass signal instances to children rather than values

```html
<!-- ✅ DO: pass the signal so child can subscribe reactively -->
<counter-display [countSignal]="state.count"></counter-display>

<!-- ❌ DON'T: pass primitive value and lose reactivity -->
<counter-display [count]="state.count()"></counter-display>
```

### Use services for cross-cutting state, components for local state

```typescript
// ✅ DO
export class LocalTimer { elapsed = signal(0); }
// Service used for app-wide preferences
```

## Common Pitfalls

- **Pitfall:** Injecting services and copying signal value to local variable.
  - **Solution:** Keep a reference to the signal or create a derived `computed` value.
- **Pitfall:** Over-exposing internals (setters) of state services.
  - **Solution:** Expose read-only signal and methods for mutations.

## Quick Reference

| Pattern | Use When | Avoid When |
|--------:|:---------|:-----------|
| Service signals | Cross-component state | Small, ephemeral UI state |
| Pass signal instance | Child needs reactive updates | Only needs initial snapshot |

## Related Topics

- [Signals: Core Concepts](core-concepts.md)
- [Computed Signals](computed-signals.md)
