---
name: Create Angular Component
description: Generate a new Angular component with tests
agent: implementation
model: claude-sonnet-4
tools:
  - edit
  - search
argument-hint: "Component name (e.g., user-profile)"
---

#tool:edit

Create an Angular component with the following specifications:

Component Name: ${input:componentName:Enter component name (e.g., user-profile)}
Feature Module: ${input:featurePath:Feature path (e.g., features/users)}

Requirements:
1. Generate component files: `${componentName}.component.ts`, `${componentName}.component.html`, `${componentName}.component.scss`, `${componentName}.component.spec.ts`.
2. Follow naming convention and put files under `src/app/${featurePath}/${componentName}/`.
3. Include lifecycle hooks: `ngOnInit`, `ngOnDestroy` and `takeUntil` teardown.
4. Add proper TypeScript types and JSDoc comments.
5. Include unit tests using TestBed and `HttpClientTestingModule` where appropriate.
6. Register component in the feature module's declarations (if present).

Current file context: ${file}
Selected code: ${selection}
Workspace root: ${workspaceFolder}
