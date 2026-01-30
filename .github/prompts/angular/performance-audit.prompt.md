---
name: performance-audit
description: "Perform a performance audit: identify change detection hot paths, heavy bindings, and zone pollution."
agent: angular-performance-expert
tools: ['search','profiling','read']
---

Steps:
1. Use `#codebase` to find large components and *ngFor usage.
2. Suggest OnPush, `trackBy`, pure pipes, and `runOutsideAngular` conversions.
3. Provide Chrome DevTools profiling commands and example flame chart interpretation.

Validation: provide a prioritized remediation todo list.
