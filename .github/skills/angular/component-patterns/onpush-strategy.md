# OnPush Strategy and Change Isolation

How to limit change detection work using OnPush-like patterns and signals.

## Core Concepts

- Restrict updates to components by using immutable state or signals to drive reactivity.
- OnPush reduces checks from parent changes; signals make reactive updates explicit.
- Prefer `class`/`style` bindings and `trackBy` to reduce DOM churn.

## Best Practices

### Prefer signals or immutable inputs over mutating objects

```typescript
// ✅ DO
// Pass a signal or a new object when updating
this.items = [...this.items, newItem];

// ❌ DON'T
// Mutate the array in-place and expect OnPush to detect changes
this.items.push(newItem);
```

### Use signals to trigger local updates without full tree checks

```typescript
// ✅ DO
count = signal(0);
increment() { this.count.update(v => v + 1); }

// ❌ DON'T
// Rely on parent change detection to force update.
```

### Avoid deep object mutation for OnPush components

```typescript
// ✅ DO
this.config = { ...this.config, mode: 'compact' };

// ❌ DON'T
this.config.mode = 'compact'; // OnPush may not detect
```

## Common Pitfalls

- **Pitfall:** Expecting OnPush to handle in-place mutations.
  - **Solution:** Use immutable updates or signal patterns.
- **Pitfall:** Overusing OnPush without training team on immutable updates.
  - **Solution:** Document patterns and enforce via code review.

## Quick Reference

| Pattern | Use When | Avoid When |
|--------:|:---------|:-----------|
| Immutable updates | Shared objects and OnPush | Very small ephemeral state |
| Signals | Local reactive updates | Legacy code that uses setters heavily |

## Related Topics

- [Signals: Core Concepts](../signals/core-concepts.md)
- [Change Detection](../performance/change-detection.md)
