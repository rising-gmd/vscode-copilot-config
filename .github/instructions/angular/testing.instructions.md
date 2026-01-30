---
name: angular-testing
description: "Testing instructions: TestBed, signals testing, OnPush, fixture.whenStable(), mocking strategies."
applyTo: "**/*.spec.ts"
---

# Angular Testing Instructions

Guidance:

- Configure TestBed to support `standalone` components and `OnPush` detection.
- Prefer `fixture.whenStable()` after asynchronous operations instead of forcing change detection.
- Use signals in tests by reading/writing the signal and asserting with `toEqual`.
- Mock external services with spies or lightweight test doubles.

## Example — basic component spec

```ts
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { CounterComponent } from './counter.component';

describe('CounterComponent', () => {
  let fixture: ComponentFixture<CounterComponent>;
  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [CounterComponent] }).compileComponents();
    fixture = TestBed.createComponent(CounterComponent);
  });

  it('increments', async () => {
    const comp = fixture.componentInstance;
    comp.increment();
    await fixture.whenStable();
    expect(comp.count()).toBe(1);
  });
});
```

## References
- https://angular.dev/guide/testing
