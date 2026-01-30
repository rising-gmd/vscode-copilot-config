---
name: Refactor for Performance
description: Identify hotspots and refactor for performance
agent: refactor-specialist
model: claude-sonnet-4
tools:
  - search
  - edit
  - codebase
argument-hint: "Target file, module, or area"
---

#tool:search

Target: ${input:target:Enter target area or file}

Requirements:
1. Identify algorithmic or rendering hotspots.
2. Provide a refactor plan with benchmarks and measured improvements.
3. Implement the refactor with tests to preserve behavior.

Current file context: ${file}
Selected code: ${selection}
