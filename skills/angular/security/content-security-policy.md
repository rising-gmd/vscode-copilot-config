# Content Security Policy (CSP)

Recommendations for CSP headers and safe resource loading in Angular apps.

## Core Concepts

- CSP reduces risk by restricting sources for scripts, styles, images, and frames via response headers.
- Prefer server-set `Content-Security-Policy` headers over meta tags where possible.
- Avoid `unsafe-inline` and `unsafe-eval` in production policies.

## Best Practices

### Use strict CSP and nonce-based inline allowances when necessary

```http
# ✅ DO (example header)
Content-Security-Policy: default-src 'self'; script-src 'self' 'nonce-<RANDOM>'; style-src 'self' 'nonce-<RANDOM>'; img-src 'self' data:;

# ❌ DON'T
# Avoid: script-src 'unsafe-inline' 'unsafe-eval'
```

### Host third-party scripts via vetted CDNs and use subresource integrity where possible

```http
// ✅ DO: add SRI + CORS-friendly CDN
<script src="https://cdn.example.com/lib.js" integrity="sha384-..." crossorigin="anonymous"></script>

// ❌ DON'T
// Paste third-party scripts directly into HTML
```

### Avoid relaxations during development leaking into production

```http
// ✅ DO
// Keep separate dev and prod policies; CI enforces production policy.

// ❌ DON'T
// Ship development CSP to production because it used inline eval.
```

## Common Pitfalls

- **Pitfall:** Using `unsafe-inline` for styles to bypass bundling issues.
  - **Solution:** Move styles to external files or use nonces.
- **Pitfall:** Relying on meta CSP tags instead of server headers.
  - **Solution:** Ensure server adds strict headers in deployment pipeline.

## Quick Reference

| Directive | Purpose | Recommendation |
|:---------|:--------|:--------------|
| `script-src` | Allowed script origins | Use 'self' and nonces; avoid unsafe-* |
| `style-src` | Allowed style origins | Use hashes/nonces instead of unsafe-inline |

## Related Topics

- [Sanitization](sanitization.md)
- [XSS Prevention](xss-prevention.md)
