---
name: Generate API Documentation
description: Produce or update OpenAPI docs and examples for controllers
agent: implementation
model: claude-sonnet-4
tools:
  - edit
  - search
argument-hint: "Controller or API area"
---

#tool:edit

Target: ${input:target:Enter controller or API area}

Requirements:
1. Ensure XML comments exist and map to OpenAPI schemas.
2. Add examples for success and error responses.
3. Produce a short `API-DOCS.md` in the controller folder with usage examples.

Current file context: ${file}
Selected code: ${selection}
