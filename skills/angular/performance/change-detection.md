# Change Detection

Practical guidance for efficient change detection and minimizing unnecessary work.

## Core Concepts

- Angular traverses the component tree to check bindings; minimize work per traversal.
- Use signals and `OnPush`-style patterns to limit checks to affected components.
- Move expensive operations outside change detection or make them asynchronous.

## Best Practices

### Use signals/computed instead of expensive template functions

```typescript
// ✅ DO
const fullName = computed(() => `${firstName()} ${lastName()}`);

// ❌ DON'T
fullNameMethod() { return `${this.first} ${this.last}`; } // called often
```

### Prefer `class`/`style` bindings over `ngClass`/`ngStyle` for perf

```html
<!-- ✅ DO -->
<div [class.active]="isActive"></div>

<!-- ❌ DON'T -->
<div [ngClass]="{active: isActive}"></div>
```

### Defer non-critical rendering

```html
<!-- ✅ DO: use native lazy techniques or render placeholders -->
<div *ngIf="isVisible">...</div>

<!-- ❌ DON'T: mount large subtrees eagerly -->
```

## Common Pitfalls

- **Pitfall:** Running heavy synchronous code during re-render.
  - **Solution:** Use `requestIdleCallback`, WebWorkers or defer to `effect` and async APIs.
- **Pitfall:** Overuse of `ngClass`/`ngStyle` on large lists.
  - **Solution:** Use class bindings and compute bitmasks if needed.

## Quick Reference

| Pattern | Use When | Avoid When |
|--------:|:---------|:-----------|
| `computed` | Derived UI values | Heavy CPU work |
| `class` bindings | Toggle classes | Dynamic class maps for many properties |

## Related Topics

- [Signals: Core Concepts](../signals/core-concepts.md)
- [Lazy Loading](lazy-loading.md)
