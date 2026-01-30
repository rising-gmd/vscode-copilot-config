---
name: angular-error-handling
description: "Error handling: global handlers, HTTP interceptors, async errors, and telemetry integration."
applyTo: "src/**/*.ts"
---

# Angular Error Handling Instructions

Best practices:

- Provide a global `ErrorHandler` for uncaught errors and integrate telemetry.
- Use HTTP interceptors to centralize error handling and user-friendly messages.
- Handle promise and async generator errors; do not swallow exceptions silently.
- Provide graceful UI fallback states for critical errors.

## Example — Global ErrorHandler (simplified)

```ts
import { ErrorHandler, Injectable } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class GlobalErrorHandler implements ErrorHandler {
  handleError(error: unknown) {
    // send to telemetry and rethrow or show a user-friendly toast
    console.error('GlobalErrorHandler', error);
  }
}
```

Register in providers at bootstrap.

## References
- https://angular.dev/best-practices/error-handling
