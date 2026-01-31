# Lazy Loading

Best practices for route and component lazy loading to reduce initial bundle sizes.

## Core Concepts

- Lazy loading defers loading of features until they're needed (routes or components).
- Use dynamic `import()` in route `loadChildren` or `loadComponent` for standalone components.
- Keep lazy chunks self-contained and small.

## Best Practices

### Lazy-load feature modules or standalone components

```typescript
// ✅ DO (route-based lazy load)
{ path: 'admin', loadChildren: () => import('./admin/admin.module').then(m => m.AdminModule) }

// ✅ DO (standalone component lazy load)
{ path: 'viewer', loadComponent: () => import('./viewer/viewer.component').then(c => c.ViewerComponent) }

// ❌ DON'T
// Import large feature modules eagerly in AppModule.
```

### Keep lazy chunks focused and avoid circular imports

```typescript
// ✅ DO
// Only include dependencies needed by the feature in the lazy chunk.

// ❌ DON'T
// Shared state that forces eager loading of lazy chunk.
```

### Use preload strategies selectively

```typescript
// ✅ DO
// Use PreloadAllModules or custom strategies for UX-sensitive routes.

// ❌ DON'T
// Preload everything if it defeats the purpose of lazy loading.
```

## Common Pitfalls

- **Pitfall:** Circular imports pulling lazy chunks into main bundle.
  - **Solution:** Audit imports; keep shared utilities in a lightweight shared chunk.
- **Pitfall:** Large lazy modules diminishing perceived performance.
  - **Solution:** Split into finer-grained lazy chunks where appropriate.

## Quick Reference

| Pattern | Use When | Avoid When |
|--------:|:---------|:-----------|
| `loadChildren` | Feature modules | Tiny features that cost little to load |
| `loadComponent` | Single large component | Component used on initial render |

## Related Topics

- [Change Detection](change-detection.md)
- [Typed Routes](../routing/typed-routes.md)
