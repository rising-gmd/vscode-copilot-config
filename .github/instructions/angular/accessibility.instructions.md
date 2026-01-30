---
name: angular-accessibility
description: "Accessibility instructions: ARIA, focus management, screen-reader announcements, keyboard navigation, CDK utilities."
applyTo: "src/**/*.ts"
---

# Angular Accessibility Instructions

Highlights:

- Use semantic HTML first; enhance with ARIA roles and properties when needed.
- Manage focus after navigation or dynamic content changes; consider `FocusMonitor` and `LiveAnnouncer` from Angular CDK.
- Ensure keyboard access for all interactive controls.
- Use `aria-*` attributes and correct roles on custom components.

## Example — using LiveAnnouncer from CDK

```ts
import { Component } from '@angular/core';
import { LiveAnnouncer } from '@angular/cdk/a11y';

@Component({
  standalone: true,
  template: `<button (click)="announce()">Announce</button>`
})
export class AnnounceComponent {
  constructor(private readonly announcer: LiveAnnouncer) {}
  announce() { this.announcer.announce('Action complete'); }
}
```

## References
- https://angular.dev/best-practices/a11y
