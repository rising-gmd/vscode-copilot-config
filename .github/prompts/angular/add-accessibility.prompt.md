---
name: add-accessibility
description: "Add accessibility improvements: ARIA labels, focus management, LiveAnnouncer usage."
agent: angular-a11y-auditor
tools: ['search','edit']
---

Steps:
1. Variable `${file}` or use `#codebase` to find target UI components.
2. Add ARIA roles, keyboard handlers, and `LiveAnnouncer` usage where dynamic updates occur.
3. Validate with a11y checklist and run automated axe checks if available.
