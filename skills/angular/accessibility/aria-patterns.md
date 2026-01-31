# ARIA Patterns

Actionable ARIA usage for accessible Angular components.

## Core Concepts

- Use ARIA to fill semantic gaps when native elements are insufficient.
- Prefer native HTML semantics first; add ARIA roles and attributes only when necessary.
- Keep ARIA attributes accurate and updated as the component state changes.

## Best Practices

### Use `role` to add semantics when necessary

```html
<!-- ✅ DO -->
<div role="dialog" aria-modal="true">...</div>

<!-- ❌ DON'T -->
<!-- Use arbitrary roles on elements that already have semantics -->
```

### Use `aria-live` for dynamic, important messages

```html
<!-- ✅ DO -->
<div role="status" aria-live="polite">Saved</div>

<!-- ❌ DON'T -->
<!-- Put noisy frequent updates into an assertive live region -->
```

### Keep `aria-hidden` in sync with visibility

```html
<!-- ✅ DO -->
<div [attr.aria-hidden]="!isVisible">...</div>

<!-- ❌ DON'T -->
<!-- Hide visually but leave aria-hidden false -->
```

## Common Pitfalls

- **Pitfall:** Overusing ARIA to fix layout issues instead of using semantic elements.
  - **Solution:** Replace divs with buttons/links/forms when appropriate.
- **Pitfall:** Forgetting to update ARIA attributes after state changes.
  - **Solution:** Tie ARIA attributes to signals/computed values or template bindings.

## Quick Reference

| Attribute | Use When | Avoid When |
|:---------|:---------|:-----------|
| `role` | Native semantics unavailable | Native element suffices |
| `aria-live` | Announce dynamic messages | Constant frequent updates |

## Related Topics

- [WCAG Compliance](wcag-compliance.md)
