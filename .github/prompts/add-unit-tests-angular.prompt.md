---
name: Add Unit Tests (Angular)
description: Add unit tests to an Angular component or service
agent: test-writer
model: claude-sonnet-4
tools:
  - edit
  - search
argument-hint: "Target file or component name"
---

#tool:edit

Target: ${input:target:Enter component/service file or selector}

Requirements:
1. Add or extend `*.spec.ts` to cover public behaviors.
2. Use TestBed and mocking strategies; include edge-case tests and error handling.
3. Ensure tests are stable and do not rely on external services (use `HttpTestingController`).

Current file context: ${file}
Selected code: ${selection}
