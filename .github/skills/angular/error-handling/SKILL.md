---
name: error-handling
description: "Error handling skill: global handlers, http interceptors and async error strategies."
---

# Error Handling Skill

When to Use: When implementing resilient UX and telemetry for production errors.

Workflow Steps:
1. Add `ErrorHandler` implementation and wire to providers.
2. Add HTTP interceptor for standardized error shapes.
3. Test retry/backoff and user-facing messaging.
