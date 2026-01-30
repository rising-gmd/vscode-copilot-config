---
name: angular-core
description: "Core Angular v21 guidelines: signals, standalone components, inject(), and style rules."
applyTo: "src/**/*.ts"
---

# Angular Core Instructions (v21)

This file provides core guidance for Angular v21 projects. Use this for chat instructions and to guide agents when creating or reviewing Angular code.

## Key guidance

- Prefer `inject()` for DI in functions and providers; use constructor injection only for classes when necessary.
- Favor standalone components and `imports` metadata over NgModules for new features.
- Use Signals for local/component state where appropriate; prefer RxJS for cross-component streams when needed.
- Use `OnPush` change detection as default for UI components.
- Use `protected` for members referenced only from templates and `readonly` where values do not change.
- Prefer `[class.foo]` and `[style.width.px]` bindings over `ngClass`/`ngStyle` for single concerns.

## Example — standalone component with signals and inject()

```ts
import { Component, signal } from '@angular/core';
import { CommonModule } from '@angular/common';

/**
 * Example standalone counter component using signals.
 */
@Component({
  selector: 'app-counter',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div>
      <button (click)="decrement()">-</button>
      <span>{{ count() }}</span>
      <button (click)="increment()">+</button>
    </div>
  `,
  changeDetection: 0
})
export class CounterComponent {
  private readonly start = 0;
  readonly count = signal<number>(this.start);

  increment() { this.count.update(v => v + 1); }
  decrement() { this.count.update(v => v - 1); }
}
```

## References
- https://angular.dev/style-guide
- https://angular.dev/guide/signals
