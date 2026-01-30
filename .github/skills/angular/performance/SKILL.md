---
name: performance
description: "Performance skills for Angular: OnPush, pure pipes, zone fixes, lazy loading."
---

# Performance Skill

When to Use: When profiling reveals re-render hotspots, large lists, or CPU-heavy computations.

Workflow Steps:
1. Profile with Chrome DevTools and Angular Profiler.
2. Apply simple fixes (OnPush, trackBy) and re-measure.
3. Move heavy computations to pure pipes or runOutsideAngular.

Best Practices and pitfalls are in examples/ and checklists/.
