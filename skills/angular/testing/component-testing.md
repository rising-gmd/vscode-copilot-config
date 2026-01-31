# Component Testing

Practical patterns for unit-testing Angular components with TestBed and signals-aware constructs.

## Core Concepts

- Test components in isolation using `TestBed.configureTestingModule` or standalone `createComponent` helpers.
- Mock dependencies and avoid network I/O in unit tests.
- Prefer asserting rendered DOM and component API contract.

## Best Practices

### Use TestBed or standalone test harnesses

```typescript
// ✅ DO
import {ComponentFixture, TestBed} from '@angular/core/testing';
TestBed.configureTestingModule({ declarations: [MyComp] }).compileComponents();

// ❌ DON'T
// Instantiate components without Angular testing harness when Angular features required.
```

### Mock services and provide test doubles

```typescript
// ✅ DO
providers: [{ provide: ApiService, useValue: { get: () => of({}) } }]

// ❌ DON'T
// Call actual HttpClient in unit tests.
```

### Test signals and computed outputs deterministically

```typescript
// ✅ DO
const fixture = TestBed.createComponent(MyComp);
fixture.detectChanges();
expect(fixture.nativeElement.textContent).toContain('Ready');

// ❌ DON'T
// Rely on time-based flakiness instead of advancing test schedulers.
```

## Common Pitfalls

- **Pitfall:** Flaky tests due to unmocked async operations.
  - **Solution:** Use fakeAsync / flush or properly mock observables and promises.
- **Pitfall:** Heavy integration tests instead of fast unit tests.
  - **Solution:** Keep unit tests focused; move E2E to Playwright.

## Quick Reference

| Pattern | Use When | Avoid When |
|--------:|:---------|:-----------|
| `TestBed` | Angular feature integration | Pure logic functions |
| Mock providers | External APIs | When integration testing a full stack |

## Related Topics

- [Reactive Forms](../forms/reactive-forms.md)
- [Signals: Core Concepts](../signals/core-concepts.md)
