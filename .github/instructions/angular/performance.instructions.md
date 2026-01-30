---
name: angular-performance
description: "Angular performance guidance: OnPush, pure pipes, runOutsideAngular, lazy loading, trackBy, profiling."
applyTo: "src/**/*.ts"
---

# Angular Performance Instructions (v21)

Key recommendations derived from official Angular docs:

- Default components to `OnPush` change detection.
- Use `signal`s and pure pipes for expensive computations.
- Use `runOutsideAngular()` for non-Angular DOM or timer tasks.
- Lazy-load feature routes and modules; use route-level code-splitting.
- Use `trackBy` for `*ngFor` lists.
- Profile with Chrome DevTools and Angular Profiler; collect flame charts and event traces.

## Example — runOutsideAngular usage

```ts
import { Component, Injector, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  standalone: true,
  imports: [CommonModule],
  template: `<div>{{value}}</div>`
})
export class HeavyTimerComponent {
  readonly zone = inject(NgZone);
  value = 0;

  ngOnInit() {
    this.zone.runOutsideAngular(() => {
      setInterval(() => { this.value++; }, 1000);
    });
  }
}
```

## References
- https://angular.dev/best-practices/runtime-performance
- https://angular.dev/best-practices/profiling-with-chrome-devtools
