# Input, Output, and Model Inputs

Practical guidance for input/output shapes and two-way (model) bindings.

## Core Concepts

- Inputs define the component API; prefer typed signals for new components.
- Model inputs (`model`) support two-way binding and automatically create `XChange` outputs.
- Outputs should use camelCase and avoid colliding with DOM events.

## Best Practices

### Name handlers for intent, not event

```html
<!-- ✅ DO -->
<button (click)="saveUserData()">Save</button>

<!-- ❌ DON'T -->
<button (click)="handleClick()">Save</button>
```

### Use model inputs for controls that mutate value

```typescript
// ✅ DO
@Component({selector: 'custom-slider'})
export class CustomSlider { value = model(0); }

// ❌ DON'T
// Use separate value + event; prefer model for built-in two-way patterns.
```

### Expose outputs as read-only and use `output()` helper for typed events

```typescript
// ✅ DO
panelClosed = output<void>();

// ❌ DON'T
@Output() panelClosed = new EventEmitter(); // less type-friendly in new APIs
```

## Common Pitfalls

- **Pitfall:** Choosing input names that shadow native DOM properties.
  - **Solution:** Avoid names like `value`, `checked` on non-form components or alias appropriately.
- **Pitfall:** Using `any` for event payloads.
  - **Solution:** Always type outputs and model values.

## Quick Reference

| Pattern | Use When | Avoid When |
|--------:|:---------|:-----------|
| `model` | Two-way bound form-like components | Stateless display-only components |
| `output()` | Typed custom events | Untyped EventEmitter usage |

## Related Topics

- [Signals-First Component Patterns](signals-first.md)
- [Template Control Flow](../templates/control-flow.md)
