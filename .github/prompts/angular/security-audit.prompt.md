---
name: security-audit
description: "Run a security audit: check XSS vectors, CSP headers, XSRF config, and DomSanitizer usage."
agent: angular-security-auditor
tools: ['search','fetch']
---

Steps:
1. Scan for uses of `bypassSecurityTrust*` and report locations.
2. Verify XSRF setup in `HttpClient` configuration.
3. Produce CSP header recommendations and Trusted Types suggestions.

Validation: produce a security-report.md with findings and remediation steps.
