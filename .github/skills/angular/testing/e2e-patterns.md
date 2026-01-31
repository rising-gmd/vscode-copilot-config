# E2E Patterns (Playwright)

Practical, reliability-focused E2E patterns using Playwright (preferred) or similar tools.

## Core Concepts

- E2E tests verify user flows end-to-end and should be fewer but higher value than unit tests.
- Prefer explicit waits for UI conditions (selectors/locator.waitFor) over fixed timeouts.
- Use test fixtures to prepare test data and reset state between runs.

## Best Practices

### Use Playwright locators and explicit assertions

```typescript
// ✅ DO
await page.locator('button:has-text("Save")').click();
await expect(page.locator('.toast')).toHaveText('Saved');

// ❌ DON'T
await page.waitForTimeout(2000); // flaky fixed delay
```

### Isolate tests with test data and cleanup

```typescript
// ✅ DO
// Use API fixtures to create test user, then run UI flow, then delete user.

// ❌ DON'T
// Assume shared global state across tests without cleanup.
```

### Avoid brittle selectors; prefer data-test ids

```html
<!-- ✅ DO -->
<button data-test="save">Save</button>

<!-- ❌ DON'T -->
<!-- Select by CSS class that changes frequently -->
```

## Common Pitfalls

- **Pitfall:** Tests that depend on external services and network reliability.
  - **Solution:** Use test doubles for third-party services or run in controlled test environments.
- **Pitfall:** Overly broad E2E test suite causing long CI times.
  - **Solution:** Keep critical path tests; move less-critical scenarios to integration tests.

## Quick Reference

| Pattern | Use When | Avoid When |
|--------:|:---------|:-----------|
| Playwright locators | Robust UI interactions | Selecting by visual layout only |
| Test fixtures | Isolate test data | Manual DB state sharing |

## Related Topics

- [Service Testing](service-testing.md)
