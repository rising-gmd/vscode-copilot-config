# GitHub Copilot Configuration (Enterprise Angular + .NET Core)

This folder contains curated instructions, agent definitions, prompts, and skills to provide a production-grade Copilot configuration for enterprise Angular + .NET Core projects.

**Structure**
- `instructions/` — Opinionated coding guidelines and apply-to glob patterns used by instruction agents.
- `agents/` — Agent role definitions, tool access and handoffs for automated collaborators.
- `prompts/` — Reusable prompt templates with variable support for common tasks (component, service, controller generation, tests).
- `skills/` — Reusable knowledge artifacts and code templates referenced by agents and prompts.

**How to use**
- Install and enable Copilot and any configured agent runner in VS Code.
- Reference `.github/copilot-instructions.md` for global standards.
- Use prompts in `prompts/` from the Copilot command palette or configured extension UI to scaffold code.
- Agents process prompts according to their declared tools and handoffs.

**Onboarding**
1. Ensure workspace contains Angular and .NET projects or add sample projects.
2. Enable the Copilot extension and grant access to workspace files.
3. Review `copilot-instructions.md` and team coding standards.

**Recommended VS Code Settings**
- Enable ESLint integration and set `editor.formatOnSave` to true.
- Enable `omnisharp` for C# language services and configure Roslyn analyzers.

**Workflows & Examples**
- Feature development flow: `architect` -> `planner` -> `implementation` -> `test-writer` -> `code-reviewer`.
- Security flow: implementation -> security-auditor -> refactor-specialist -> code-reviewer.

**Tool reference**
- Prompts can reference tools using `#tool:toolName` in their bodies, and frontmatter declares tools available to the prompt's agent.

**Maintainer Notes**
- Keep SKILL.md examples minimal and focused.
- Keep prompts idempotent and safe to re-run.
- Validate frontmatter YAML after edits.
