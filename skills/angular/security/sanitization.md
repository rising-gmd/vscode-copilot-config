# Sanitization

Guidance for safe handling of HTML and resource URIs using the Angular sanitizer APIs.

## Core Concepts

- Angular provides `DomSanitizer` for working with potentially unsafe values; prefer sanitized APIs.
- Avoid `bypassSecurityTrust*` except for audited, reviewed cases.
- Prefer rendering plain text or sanitized markdown instead of raw HTML.

## Best Practices

### Sanitize or avoid `innerHTML`

```typescript
// ✅ DO
const safe = this.sanitizer.sanitize(SecurityContext.HTML, userHtml);
element.innerHTML = safe ?? '';

// ❌ DON'T
element.innerHTML = this.sanitizer.bypassSecurityTrustHtml(userHtml) as string;
```

### Prefer markdown-to-sanitized-HTML pipelines

```typescript
// ✅ DO
const html = markdownToHtml(raw); // trusted converter
const sanitized = this.sanitizer.sanitize(SecurityContext.HTML, html);

// ❌ DON'T
// Render raw converted HTML without sanitization.
```

### Limit uses of `bypassSecurityTrust*`

```typescript
// ✅ DO
// Use bypass only for static known-safe assets with clear code review.

// ❌ DON'T
// Use bypass on arbitrary user-provided strings.
```

## Common Pitfalls

- **Pitfall:** Treating `bypassSecurityTrustHtml` return type as string and assigning directly.
  - **Solution:** Sanitize values and prefer safe rendering paths.
- **Pitfall:** Using `data:` URIs without validation.
  - **Solution:** Restrict allowed schemes and validate size/format.

## Quick Reference

| Pattern | Use When | Avoid When |
|--------:|:---------|:-----------|
| `sanitize` | Render converted HTML | Bypassing sanitizer |
| `bypassSecurityTrust*` | Static trusted assets | User content |

## Related Topics

- [XSS Prevention](xss-prevention.md)
