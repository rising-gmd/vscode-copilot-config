---
name: add-unit-tests
description: "Generate unit tests for a given component/service using TestBed and OnPush patterns."
agent: angular-test-writer
tools: ['search','edit','run_in_terminal']
---

Steps:
1. Variable `${file}` — target file to test.
2. Create a `.spec.ts` that imports the target as standalone and uses `fixture.whenStable()` for async.
3. Add mocks for external dependencies and example assertions.
4. Run `npm test -- --watch=false` to validate tests pass.
