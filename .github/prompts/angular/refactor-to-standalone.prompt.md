---
name: refactor-to-standalone
description: "Refactor a component and its dependencies to be standalone."
agent: angular-architect
tools: ['search','edit']
---

Steps:
1. Input `${file}` target component.
2. Identify NgModule bindings and convert them into `imports` on the component or feature-level route.
3. Update lazy routes to load standalone components directly.
4. Validation: run build (`npm run build`) and run unit tests.
