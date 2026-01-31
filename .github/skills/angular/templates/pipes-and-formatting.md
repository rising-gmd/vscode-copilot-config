# Pipes and Formatting

Guidance for using pipes, formatting data in templates, and avoiding heavy formatting work in templates.

## Core Concepts

- Use built-in or custom pipes to format data in templates; pipes are pure by default.
- Avoid calling component methods that compute formatted strings on every change detection.
- Prefer `DatePipe`, `CurrencyPipe`, and custom pure pipes for reusable formatting.

## Best Practices

### Use pipes for presentation formatting

```html
<!-- ✅ DO -->
{{ order.date | date:'short' }}

<!-- ❌ DON'T -->
{{ formatDate(order.date) }} <!-- method runs every check -->
```

### Implement pure pipes for stateless formatting

```typescript
// ✅ DO
import { Pipe, PipeTransform } from '@angular/core';
@Pipe({name: 'truncate', pure: true})
export class TruncatePipe implements PipeTransform { transform(v: string, len = 50){ return v.length>len? v.slice(0,len)+'...':v; } }

// ❌ DON'T
// Use impure pipes for common formatting; they run frequently.
```

### Avoid formatting heavy structures in templates

```html
<!-- ✅ DO -->
<div>{{ summary() }}</div> <!-- precomputed via computed signal -->

<!-- ❌ DON'T -->
<div>{{ items.map(i => i.name).join(', ') }}</div>
```

## Common Pitfalls

- **Pitfall:** Creating impure pipes that recompute on every change.
  - **Solution:** Keep pipes pure or add manual caching if necessary.
- **Pitfall:** Formatting large collections inside templates.
  - **Solution:** Precompute with `computed` and bind to the result.

## Quick Reference

| Pattern | Use When | Avoid When |
|--------:|:---------|:-----------|
| Pure pipes | Stateless formatting | Data that changes every frame |
| `computed` | Complex derived strings | Inline template logic |

## Related Topics

- [Computed Signals](../signals/computed-signals.md)
- [Template Control Flow](control-flow.md)
