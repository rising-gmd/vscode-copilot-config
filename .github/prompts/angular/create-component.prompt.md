---
name: create-component
description: "Scaffold a standalone Angular component with OnPush and signals."
agent: angular-architect
tools: ['createFile','edit','run_in_terminal']
---

Steps:

1. Input variables: `componentName` (use `${input:componentName}`) and `path` (default `${workspaceFolder}/src/app`).
2. Run `ng generate component ${input:componentName} --standalone --changeDetection OnPush` as template step.
3. Create a signal-based state example and export public selectors.
4. Validate: open `${file}` and ensure `standalone: true` and `changeDetection: 0`.

Validation:
- Confirm file present at `${workspaceFolder}/src/app/${input:componentName}/${input:componentName}.component.ts`.
