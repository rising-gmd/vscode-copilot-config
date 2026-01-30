---
name: Add Error Handling
description: Add consistent error handling and mappings across layers
agent: implementation
model: claude-sonnet-4
tools:
  - edit
  - search
argument-hint: "Target file or module"
---

#tool:edit

Target: ${input:target:Enter target file or module}

Requirements:
1. Add consistent error objects and map them to UI-friendly messages or API error payloads.
2. Ensure telemetry/logging includes correlationId and context.
3. Include tests that assert error paths and logging.

Current file context: ${file}
Selected code: ${selection}
