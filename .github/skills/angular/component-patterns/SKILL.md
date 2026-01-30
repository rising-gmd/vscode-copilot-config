---
name: component-patterns
description: "Component patterns: when and how to design components, services, directives, and pipes."
---

# Component Patterns Skill

When to Use: When creating or refactoring UI components to follow Angular v21 best practices (standalone, OnPush, signals).

Workflow Steps:

1. Discovery: locate the component and its module boundaries.
2. Plan: decide standalone vs feature module and signal vs observable for state.
3. Implement: scaffold component, move logic to services where appropriate.
4. Validate: lint, test, and run accessibility and performance checks.

Best Practices:
- Keep components focused and presentational; push business logic to services.
- Use `inject()` in providers and factories.
- Use `protected` for template-only members and `readonly` for immutable fields.

Common Pitfalls:
- Overusing RxJS for purely local state.
- Large components that mix concerns — split into child components.

Examples and checklists are provided in the examples/ and checklists/ folders.
