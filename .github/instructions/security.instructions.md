---
name: Security Best Practices
description: OWASP top 10, input validation, auth/authorization, secrets handling
applyTo: "**"
---

# Security

## OWASP Top 10
- Validate and sanitize all input. Treat client input as untrusted.
- Protect against XSS, CSRF, injection, and broken auth by design.

## Auth & AuthZ
- Use OAuth2/OpenID Connect where possible. Prefer claims-based authorization in APIs.
- Enforce least-privilege and role-based policies.

## Secrets
- Use environment variables or secret stores (Azure Key Vault, AWS Secrets Manager).
- Ensure CI/CD pipelines do not leak secrets; rotate regularly.

## Secure Defaults
- Enforce HTTPS, HSTS headers, and use secure cookie attributes.
- Log security-relevant events with correlation IDs for incident triage.
