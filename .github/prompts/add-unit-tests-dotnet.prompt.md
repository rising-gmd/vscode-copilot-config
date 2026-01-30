---
name: Add Unit Tests (.NET)
description: Add unit tests to a .NET service or controller
agent: test-writer
model: claude-sonnet-4
tools:
  - edit
  - search
argument-hint: "Target class or service name"
---

#tool:edit

Target: ${input:target:Enter class or service name}

Requirements:
1. Add xUnit tests following AAA pattern.
2. Use `Moq` for dependencies and `FluentAssertions` for assertions.
3. Ensure tests run without external dependencies using in-memory providers or mocks.

Current file context: ${file}
Selected code: ${selection}
