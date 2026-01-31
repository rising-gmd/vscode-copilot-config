# Signals-First Component Patterns

How to design components by prioritizing signals and reactive inputs.

## Core Concepts

- Components should use signals for internal state and accept signals for inputs when consumers require reactivity.
- Prefer `inject()` for dependencies where appropriate and `readonly` for Angular-initialized properties.
- Group Angular-specific properties (inputs, outputs, queries) before methods.

## Best Practices

### Use `input()` signals for component inputs (signals-based API)

```typescript
// ✅ DO
import {Component, input} from '@angular/core';
@Component({selector: 'counter'})
export class CounterCmp {
  readonly count = input(0);
}

// ❌ DON'T
@Component({selector: 'counter-bad'})
export class CounterCmpBad {
  @Input() count = 0; // avoids signal benefits
}
```

### Prefer `protected` for members used only by templates

```typescript
// ✅ DO
export class UserProfile { protected fullName = computed(() => `${this.first()} ${this.last()}`); }

// ❌ DON'T
// Make everything public by default.
```

### Avoid complex logic in lifecycle hooks; call well-named methods instead

```typescript
// ✅ DO
ngOnInit() { this.setupPolling(); }

// ❌ DON'T
ngOnInit() { /* dozens of lines of logic */ }
```

## Common Pitfalls

- **Pitfall:** Mixing signal-based inputs and decorator-based inputs inconsistently.
  - **Solution:** Standardize on signals for new components; use `@Input` only when necessary.
- **Pitfall:** Exposing writable signal internals directly.
  - **Solution:** Expose read-only signals and methods to mutate.

## Quick Reference

| Pattern | Use When | Avoid When |
|--------:|:---------|:-----------|
| `input()` signal | Component expects reactive updates | Backwards compatibility with existing code |
| `protected` members | Template-only usage | Public API surface for DI |

## Related Topics

- [Signals: Core Concepts](../signals/core-concepts.md)
- [Input/Output & Model Inputs](input-output-model.md)
