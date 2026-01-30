---
name: migrate-to-signals
description: "Plan and implement migration of local state from RxJS Observables to Signals where appropriate."
agent: angular-architect
tools: ['search','edit','read']
---

Steps:
1. Identify component-local Observables used only for local view state.
2. Propose signals replacements and implement a sample conversion in a branch.
3. Add unit tests that assert signal updates.

Validation: ensure public APIs remain unchanged; run tests.
