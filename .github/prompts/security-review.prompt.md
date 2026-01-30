---
name: Security Review
description: Run a focused security review on code or configuration
agent: security-auditor
model: claude-sonnet-4
tools:
  - search
  - codebase
  - problems
argument-hint: "File, folder, or module to scan"
---

#tool:search

Target: ${input:target:Enter file/folder}

Requirements:
1. Run OWASP-focused checks and flag high/critical issues.
2. Provide remediation steps and references.
3. Produce a short report with CVSS-like severity and suggested PR changes.

Current file context: ${file}
Selected code: ${selection}
