# Defer Non-Critical Work

Strategies to defer non-critical rendering and computation to improve perceived performance.

## Core Concepts

- Defer expensive rendering or work until after initial paint using idle callbacks, intersection observers, or dynamic imports.
- Prioritize above-the-fold content and lazy-load below-the-fold features.
- Use placeholders for deferred content to keep layout stable.

## Best Practices

### Use `requestIdleCallback` or `setTimeout` for non-urgent work

```typescript
// ✅ DO
requestIdleCallback(() => heavySetup());

// ❌ DON'T
// Run heavySetup synchronously during initial render.
```

### Lazy-load components with dynamic import when offscreen

```typescript
// ✅ DO
const comp = await import('./heavy.component').then(m => m.HeavyComponent);

// ❌ DON'T
// Import heavy components eagerly in root bundle.
```

### Use IntersectionObserver to load images/components when visible

```typescript
// ✅ DO
const io = new IntersectionObserver(entries => { if(entries[0].isIntersecting) load(); });

// ❌ DON'T
// Load all images at once regardless of viewport.
```

## Common Pitfalls

- **Pitfall:** Over-deferring critical UI that makes app feel broken.
  - **Solution:** Always render meaningful placeholders and keep navigation responsive.
- **Pitfall:** Using too many idle callbacks causing scheduling complexity.
  - **Solution:** Batch deferred tasks and monitor timings with profiler.

## Quick Reference

| Pattern | Use When | Avoid When |
|--------:|:---------|:-----------|
| `requestIdleCallback` | Non-urgent initialization | Critical interactive flows |
| Dynamic import | Large components | Small shared utilities |

## Related Topics

- [Lazy Loading](lazy-loading.md)
- [Change Detection](change-detection.md)
