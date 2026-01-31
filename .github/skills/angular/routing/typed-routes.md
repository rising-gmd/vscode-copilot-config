# Typed Routes

Guidance for strongly-typed routing, lazy-loading, and guards.

## Core Concepts

- Define typed route params and use route matchers for safety.
- Prefer lazy-loading feature modules for large routes.
- Use functional guards (or typed classes) with explicit return types.

## Best Practices

### Use typed route parameters and helpers

```typescript
// ✅ DO
import {ActivatedRoute} from '@angular/router';
class DetailCmp {
  constructor(route: ActivatedRoute) {
    const id = route.snapshot.paramMap.get('id');
  }
}

// ❌ DON'T
// Parse params from URL manually across components.
```

### Lazy-load feature modules via route configuration

```typescript
// ✅ DO
const routes = [ { path: 'admin', loadChildren: () => import('./admin/admin.module').then(m => m.AdminModule) } ];

// ❌ DON'T
// Bundle all features into root module causing larger initial bundles.
```

### Use guards for authorization and data loading

```typescript
// ✅ DO
// Use CanActivate guards that return boolean | UrlTree | Observable/Promise

// ❌ DON'T
// Put access checks in components' ngOnInit instead of guards.
```

## Common Pitfalls

- **Pitfall:** Forgetting to type route params and assuming presence.
  - **Solution:** Validate and provide fallbacks or typedguards.
- **Pitfall:** Guard returning `null` or incorrect types.
  - **Solution:** Always return proper types per router contract.

## Quick Reference

| Pattern | Use When | Avoid When |
|--------:|:---------|:-----------|
| Lazy loading | Large feature modules | Very small apps |
| Guards | Auth or precondition checks | Small view-only routes |

## Related Topics

- [Typed Requests](../http/typed-requests.md)
- [Lazy Loading](../performance/lazy-loading.md)
