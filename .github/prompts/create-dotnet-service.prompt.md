---
name: Create .NET Service
description: Generate a .NET service class, interface, and tests
agent: implementation
model: claude-sonnet-4
tools:
  - edit
  - search
argument-hint: "Service name (e.g., UserService)"
---

#tool:edit

Service Name: ${input:serviceName:Enter service name (e.g., UserService)}
Namespace: ${input:namespace:Enter project namespace (e.g., MyCompany.Project.Application.Services)}

Requirements:
1. Create an interface `I${serviceName}.cs` and implementation `${serviceName}.cs` under `Services/`.
2. Include async method signatures (e.g., `Task<T> GetAsync(...)`).
3. Register service in DI container with recommended lifetime.
4. Add unit tests using xUnit and `Moq`.

Current file context: ${file}
Selected code: ${selection}
