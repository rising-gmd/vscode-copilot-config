# XSS Prevention

Concrete guidance to prevent Cross-Site Scripting (XSS) in Angular applications.

## Core Concepts

- Angular templates sanitize untrusted HTML by default when using interpolation.
- Avoid bypassing the sanitizer (`DomSanitizer.bypassSecurityTrust*`) unless absolutely necessary and with clear justification.
- Validate and encode data received from untrusted sources before rendering.

## Best Practices

### Never bypass the sanitizer for user-provided content

```typescript
// ✅ DO
// Use safe rendering: bind to text or sanitized HTML only after explicit checks.

// ❌ DON'T
this.sanitizer.bypassSecurityTrustHtml(userHtml); // avoid except with strict review
```

### Use `innerText`/interpolation for plain text

```html
<!-- ✅ DO -->
<div>{{ userProvidedText }}</div>

<!-- ❌ DON'T -->
<div [innerHTML]="userProvidedText"></div>
```

### Validate and coerce incoming data on the client side

```typescript
// ✅ DO
function safeName(raw: unknown): string { return String(raw ?? '').trim().slice(0, 200); }

// ❌ DON'T
// Render raw values directly.
```

## Common Pitfalls

- **Pitfall:** Using `innerHTML` for templating user content.
  - **Solution:** Render sanitized fragments or use safe templates.
- **Pitfall:** Storing HTML in database and rendering without validation.
  - **Solution:** Sanitize at ingest and before render; prefer markdown -> sanitized HTML pipeline.

## Quick Reference

| Pattern | Use When | Avoid When |
|--------:|:---------|:-----------|
| Interpolation | Display user text | Rendering HTML fragments |
| DOMSanitizer bypass | Very limited, audited cases | Normal user content |

## Related Topics

- [Typed Requests](../http/typed-requests.md)
- [WCAG Compliance](../accessibility/wcag-compliance.md)
