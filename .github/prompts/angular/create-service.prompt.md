---
name: create-service
description: "Create an Angular injectable service using `inject()` and providedIn: 'root'."
agent: angular-architect
tools: ['createFile','edit']
---

Steps:
1. Ask for `serviceName` and `path` variables.
2. Scaffold a `standalone` service file that uses `inject()` for dependent services where applicable.
3. Add JSDoc and export typings.
4. Validation: ensure `providedIn: 'root'` and `inject()` not used in constructor.

CLI hint: `ng generate service ${input:serviceName}`
