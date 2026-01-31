# View Encapsulation

Guidance on choosing view encapsulation modes and avoiding scoped-style pitfalls.

## Core Concepts

- Angular supports `Emulated`, `ShadowDom`, `ExperimentalIsolatedShadowDom`, and `None`.
- `Emulated` is the default; `ShadowDom` uses native shadow roots and changes event propagation.
- Avoid `::ng-deep` for new code — it's deprecated and can create global style leakage.

## Best Practices

### Prefer `Emulated` for component isolation

```typescript
// ✅ DO
@Component({ encapsulation: ViewEncapsulation.Emulated })
export class Profile {}

// ❌ DON'T
@Component({ encapsulation: ViewEncapsulation.None }) // without clear intent
```

### Use `ShadowDom` when true encapsulation is required

```typescript
// ✅ DO
@Component({ encapsulation: ViewEncapsulation.ShadowDom })
export class Widget {}

// ❌ DON'T
// Use ShadowDom without verifying slot/ARIA and event implications.
```

### Avoid `::ng-deep` for new styling needs

```css
/* ✅ DO */
/* Use shared CSS variables or global stylesheet for overrides */

/* ❌ DON'T */
/* ::ng-deep .some-class { ... } */
```

## Common Pitfalls

- **Pitfall:** Relying on `::ng-deep` to style children from parent — leads to maintenance issues.
  - **Solution:** Use theme tokens or CSS variables and keep styles modular.
- **Pitfall:** Unexpected event behavior when using Shadow DOM.
  - **Solution:** Test focus and slot interaction when choosing ShadowDom.

## Quick Reference

| Mode | Use When | Avoid When |
|:----|:---------|:-----------|
| Emulated | Typical components | Needing absolute shadow isolation |
| ShadowDom | Encapsulation + web components | Complex global styles relying on DOM structure |

## Related Topics

- [Styling: Templates and Binding](../templates/control-flow.md)
