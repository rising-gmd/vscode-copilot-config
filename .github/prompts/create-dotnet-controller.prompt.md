---
name: Create .NET Controller
description: Generate a new ASP.NET Core controller with DTOs and tests
agent: implementation
model: claude-sonnet-4
tools:
  - edit
  - search
argument-hint: "Controller name (e.g., Users)"
---

#tool:edit

Controller Name: ${input:controllerName:Enter controller name (e.g., Users)}
Namespace: ${input:namespace:Enter project namespace (e.g., MyCompany.Project.Api.Controllers)}

Requirements:
1. Generate `Controllers/${controllerName}Controller.cs`, DTOs under `DTOs/`, and a corresponding `*ControllerTests.cs` using xUnit.
2. Follow REST conventions, return proper IActionResult types, and include XML comments for OpenAPI.
3. Inject service via constructor and validate incoming DTOs.

Current file context: ${file}
Selected code: ${selection}
#tool:search
