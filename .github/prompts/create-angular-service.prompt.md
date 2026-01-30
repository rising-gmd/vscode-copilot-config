---
name: Create Angular Service
description: Generate an Angular injectable service with tests
agent: implementation
model: claude-sonnet-4
tools:
  - edit
  - search
argument-hint: "Service name (e.g., user-service)"
---

#tool:edit

Service Name: ${input:serviceName:Enter service name (e.g., user-service)}
Feature Module: ${input:featurePath:Feature path (e.g., features/users)}

Requirements:
1. Generate `*.service.ts` and `*.service.spec.ts` under `src/app/${featurePath}/services/`.
2. Include `providedIn: 'root'` or module-level provider based on user choice.
3. Use `HttpClient` with typed request/response DTOs and error handling via `ErrorService`.
4. Provide RxJS-friendly APIs returning `Observable<T>` and include proper cancellation semantics.

Current file context: ${file}
Selected code: ${selection}
#tool:search
