# WCAG Compliance and ARIA Patterns

Actionable accessibility guidance for Angular components and templates.

## Core Concepts

- Follow WCAG guidelines: perceptible, operable, understandable, robust.
- Use semantic HTML where possible; augment with ARIA only when necessary.
- Ensure keyboard focus order and visible focus indicators.

## Best Practices

### Prefer semantic elements and native controls

```html
<!-- ✅ DO -->
<button (click)="save()">Save</button>

<!-- ❌ DON'T -->
<div role="button" (click)="save()">Save</div>
```

### Use ARIA attributes only to enhance semantics

```html
<!-- ✅ DO -->
<div role="alert" aria-live="assertive">Error occurred</div>

<!-- ❌ DON'T -->
<!-- Overuse ARIA roles or use incorrect role values -->
```

### Ensure keyboard navigation and focus management

```html
<!-- ✅ DO -->
<a routerLink="/next">Next</a>

<!-- ❌ DON'T -->
<div (keydown.enter)="goNext()">Next</div>
```

## Common Pitfalls

- **Pitfall:** Relying on CSS visibility only to hide elements; screen readers may still access them.
  - **Solution:** Use proper `aria-hidden` and remove from DOM when appropriate.
- **Pitfall:** Non-descriptive link or button labels.
  - **Solution:** Use meaningful text or `aria-label` when necessary.

## Quick Reference

| Pattern | Use When | Avoid When |
|--------:|:---------|:-----------|
| Semantic controls | Standard interactive elements | Styling-only layouts |
| `role`/`aria-*` | Add missing semantics | Replace native semantics |

## Related Topics

- [Template Control Flow](../templates/control-flow.md)
- [XSS Prevention](../security/xss-prevention.md)
