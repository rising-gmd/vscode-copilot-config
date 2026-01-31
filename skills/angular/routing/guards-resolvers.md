# Guards and Resolvers

Patterns for route guards (`CanActivate`/`CanLoad`) and resolvers to fetch data before navigation.

## Core Concepts

- Guards decide whether navigation should proceed; resolvers fetch required data before route activation.
- Guards/resolvers may return `boolean | UrlTree | Observable<boolean|UrlTree> | Promise<...>`.
- Keep guards small and side-effect-free; use services for complex logic.

## Best Practices

### Return typed results and handle async properly

```typescript
// ✅ DO
@Injectable({providedIn:'root'})
export class AuthGuard implements CanActivate {
  canActivate(route: ActivatedRouteSnapshot) { return this.auth.isLoggedIn$().pipe(map(v => v ? true : this.router.parseUrl('/login'))); }
}

// ❌ DON'T
// Perform navigation inside guard; return proper UrlTree instead.
```

### Use resolvers to hydrate route data

```typescript
// ✅ DO
resolve(route: ActivatedRouteSnapshot) { return this.api.getItem(route.paramMap.get('id')); }

// ❌ DON'T
// Fetch data in component constructor and block UI with untyped promises.
```

### Keep guards composable and testable

```typescript
// ✅ DO
// Delegate checks to AuthService; keep guard logic thin.

// ❌ DON'T
// Hardcode policy checks in multiple guards across app.
```

## Common Pitfalls

- **Pitfall:** Returning `null` or `undefined` from guard/resolver.
  - **Solution:** Always return the allowed types per router contract.
- **Pitfall:** Making heavy synchronous calls in guards.
  - **Solution:** Use async pipelines and show loading UI where appropriate.

## Quick Reference

| Pattern | Use When | Avoid When |
|--------:|:---------|:-----------|
| `CanActivate` | Protect routes | Minor UI toggles inside components |
| Resolver | Needs data before render | Data can be lazy-loaded inside component |

## Related Topics

- [Typed Routes](typed-routes.md)
- [Lazy Loading](../performance/lazy-loading.md)
