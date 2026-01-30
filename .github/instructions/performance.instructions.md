---
name: Performance Guidance
description: Angular and .NET performance best practices, caching, and profiling
applyTo: "**"
---

# Performance

## Angular
- Use `OnPush` change detection for large lists and components with immutable inputs.
- Lazy load modules and use `trackBy` for `*ngFor` lists.

## .NET
- Prefer async I/O and avoid blocking calls. Use `ConfigureAwait(false)` where appropriate.
- Implement caching strategies (in-memory and distributed) for expensive reads.

## Profiling
- Use browser devtools and Angular profiler for frontend.
- Use dotnet-trace, dotnet-counters and Application Insights for backend telemetry.
