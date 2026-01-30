---
name: migrate-to-onpush
description: "Guided migration to OnPush change detection for selected components."
agent: performance-expert
tools: ['search','edit']
---

Steps:
1. Search for components without `changeDetection: OnPush` in `${workspaceFolder}`.
2. For each candidate, produce a migration plan: update decorator, ensure inputs use `readonly` or signals, add `trackBy` to lists.
3. Create PR suggestions and checklist entries.

Validation: run unit tests and smoke the UI.
