---
name: angular-security
description: "Angular security best practices: AOT, CSP, Trusted Types, XSS/XSRF protections, DomSanitizer guidance."
applyTo: "src/**/*.ts"
---

# Angular Security Instructions (v21)

Essentials:

- Build production with AOT, strict templates, and build optimizer.
- Enforce Content Security Policy (CSP) with nonces where server can inject nonces.
- Use Trusted Types in browser to reduce DOM XSS surface.
- Always sanitize untrusted HTML with `DomSanitizer` and never use `bypassSecurityTrust*` without validation.
- Implement XSRF token handling for HTTP requests (Angular `HttpClient` XSRF features).

## Example — HttpClient XSRF setup (short)

```ts
import { HttpClientModule, HTTP_INTERCEPTORS } from '@angular/common/http';
import { provideHttpClient, withXsrf } from '@angular/common/http';

// In your bootstrap or providers
export const httpProviders = [
  provideHttpClient(withXsrf({ cookieName: 'XSRF-TOKEN', headerName: 'X-XSRF-TOKEN' }))
];
```

## References
- https://angular.dev/best-practices/security
