# Template Control Flow

Guidance for template bindings, control-flow, and avoiding expensive template expressions.

## Core Concepts

- Templates are evaluated during change detection; keep expressions simple and side-effect free.
- Prefer structural directives for control flow but avoid heavy computation inside template expressions.
- Use `trackBy` for `*ngFor` lists to avoid unnecessary DOM churn.

## Best Practices

### Use `trackBy` with `*ngFor`

```html
<!-- ✅ DO -->
<li *ngFor="let item of items; trackBy: trackById">{{ item.name }}</li>

<!-- ❌ DON'T -->
<li *ngFor="let item of items">{{ item.name }}</li>
```

```typescript
trackById(index: number, item: {id:string}) { return item.id; }
```

### Avoid heavy computations in template expressions

```html
<!-- ✅ DO -->
<div>{{ fullName() }}</div>

<!-- ❌ DON'T -->
<div>{{ computeExpensive(value) }}</div>
```

### Use `ng-container` for grouping without extra DOM nodes

```html
<!-- ✅ DO -->
<ng-container *ngIf="condition"> <child-comp /> </ng-container>

<!-- ❌ DON'T -->
<div *ngIf="condition"> <child-comp /> </div> <!-- extra element may break styles -->
```

## Common Pitfalls

- **Pitfall:** Using functions in templates that perform work on every check.
  - **Solution:** Use `computed` signals or precomputed values.
- **Pitfall:** Forgetting `trackBy` for lists of objects.
  - **Solution:** Always provide stable keys for lists.

## Quick Reference

| Pattern | Use When | Avoid When |
|--------:|:---------|:-----------|
| `trackBy` | Large lists or frequent updates | Static, tiny lists |
| `ng-container` | Group structural directives | Need extra wrapper element |

## Related Topics

- [Signals: Core Concepts](../signals/core-concepts.md)
- [Component Patterns: Input/Output](../component-patterns/input-output-model.md)
