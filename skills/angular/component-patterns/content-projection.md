# Content Projection

Best practices for using `<ng-content>` and multi-slot projection.

## Core Concepts

- `<ng-content>` projects child content into component templates at compile-time.
- Use `select` attributes to create named projection slots; provide fallback content when appropriate.
- Avoid conditional instantiation of `<ng-content>` placeholders — projection is static.

## Best Practices

### Use select-based slots for structured projection

```html
<!-- ✅ DO -->
<ng-content select="card-title"></ng-content>
<ng-content></ng-content>

<!-- ❌ DON'T -->
<!-- Rely on runtime DOM queries to move content. -->
```

### Provide fallback content for optional slots

```html
<!-- ✅ DO -->
<ng-content select="card-body">Default body</ng-content>

<!-- ❌ DON'T -->
<!-- Leave blank and assume consumers will always provide content. -->
```

### Use `ngProjectAs` for compatibility when needed

```html
<!-- ✅ DO -->
<h3 ngProjectAs="card-title">Title</h3>

<!-- ❌ DON'T -->
<!-- Dynamically set ngProjectAs — it must be static. -->
```

## Common Pitfalls

- **Pitfall:** Trying to conditionally create `<ng-content>` with structural directives.
  - **Solution:** Render conditionally in consuming templates or use `ng-template` fragments.
- **Pitfall:** Expecting projection to alter component change detection.
  - **Solution:** Projection does not change the host component's detection lifecycle; design accordingly.

## Quick Reference

| Pattern | Use When | Avoid When |
|--------:|:---------|:-----------|
| `select` slots | Multiple projection areas | Single simple projection |
| `ngProjectAs` | Compatibility with existing markup | Dynamic selector requirements |

## Related Topics

- [Component Lifecycle](../templates/control-flow.md)
