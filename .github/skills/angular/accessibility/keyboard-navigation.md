# Keyboard Navigation

Guidance to make components keyboard operable and focus-manageable.

## Core Concepts

- Ensure interactive controls are reachable by keyboard (use native controls where possible).
- Manage focus programmatically when dialogs or routers change view.
- Use `tabindex` sparingly and avoid `tabindex="-1"` on interactive elements unless necessary.

## Best Practices

### Use native controls for built-in keyboard behavior

```html
<!-- ✅ DO -->
<button (click)="save()">Save</button>

<!-- ❌ DON'T -->
<div role="button" tabindex="0" (keydown.enter)="save()">Save</div>
```

### Manage focus when opening dialogs or navigating

```typescript
// ✅ DO
dialogRef.afterOpened().subscribe(() => dialogElement.focus());

// ❌ DON'T
// Rely on user to find newly opened dialog with keyboard
```

### Avoid stealing focus unexpectedly; use `aria-hidden` when hiding content

```html
<!-- ✅ DO -->
<div [attr.aria-hidden]="!isOpen">...</div>

<!-- ❌ DON'T -->
// Force focus changes without announcing context to screen readers
```

## Common Pitfalls

- **Pitfall:** Custom widgets without keyboard support.
  - **Solution:** Implement full keyboard spec for the widget and test with keyboard-only flows.
- **Pitfall:** Using `tabindex` to reorder focus arbitrarily.
  - **Solution:** Keep DOM order natural and use skip links when needed.

## Quick Reference

| Pattern | Use When | Avoid When |
|:------:|:---------|:-----------|
| Native controls | Default keyboard behaviors desired | Purely decorative elements |
| Programmatic focus | Dialog open/close flows | Arbitrary focus jumps during normal navigation |

## Related Topics

- [WCAG Compliance](wcag-compliance.md)
