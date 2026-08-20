# Transport security, headers, and frontend hardening

> **Status: §2 and §3 Implemented for the API origin (Phase 1)** —
> `apps/api/src/common/middleware/security-headers.middleware.ts`, asserted header by header in
> `apps/api/src/app.integration.spec.ts`. §1 (edge TLS), §4 (CORS), §5 (cookies) and §6
> (frontend hardening) are Designed only: there is no edge, no authentication, and no
> `apps/web` yet.

## 1. Transport

TLS 1.2 minimum (1.3 preferred), modern ciphers, HTTP redirected to HTTPS at the edge.
HSTS `max-age=31536000; includeSubDomains; preload`. Certificates managed by Cloudflare
with automatic renewal; internal service-to-service traffic stays on a private network and
uses TLS where it crosses a trust boundary.

## 2. Response headers

Applied to every application response:

| Header | Value |
|---|---|
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains; preload` |
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` (and `frame-ancestors 'none'` in CSP) |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=()` |
| `Cross-Origin-Opener-Policy` | `same-origin` |
| `Cross-Origin-Resource-Policy` | `same-origin` |
| `Cross-Origin-Embedder-Policy` | `require-corp` on the app origin |
| `Cache-Control` | `no-store` on all authenticated responses |

## 3. Content Security Policy

Strict, nonce-based, **no `unsafe-inline`, no `unsafe-eval`**:

```
default-src 'self';
script-src 'self' 'nonce-{RANDOM}' 'strict-dynamic';
style-src 'self' 'nonce-{RANDOM}';
img-src 'self' data: blob:;
font-src 'self';
connect-src 'self' https://api.sentinel.example https://sentry.example;
frame-ancestors 'none';
form-action 'self';
base-uri 'self';
object-src 'none';
upgrade-insecure-requests;
report-uri /api/v1/csp-report
```

Nonces are generated per request. `report-uri` is wired from day one and the reports are
actually read — a CSP nobody monitors is decoration. The evidence-viewer origin gets its own,
even tighter policy (`default-src 'none'; img-src 'self'; style-src 'nonce-…'`).

As shipped on the API origin, `connect-src` is `'self'`: the example hosts above name the
*web* origin's API and Sentry endpoints, and the API initiates no browser connections of its
own. The `/api/v1/csp-report` collector named by `report-uri` **does not exist yet** — it
arrives with `apps/web`, and until then a violation report gets a 404. `Cache-Control:
no-store` is sent on every API response rather than only authenticated ones, and Express's
default `ETag` is disabled: a revalidation token for a response the client was told not to
store is a contradiction, and computing it means hashing tenant data on every request.

## 4. CORS

The application API is same-origin, so CORS is not a general permission. A narrow allowlist
covers the marketing site and documented integration origins; credentials are allowed only
for the application origin. **No wildcard with credentials, ever.** API-key-authenticated
endpoints do not need CORS credentials at all.

## 5. Cookies

| Cookie | Flags |
|---|---|
| `__Host-session` | `HttpOnly; Secure; SameSite=Lax; Path=/` |
| `csrf` | `Secure; SameSite=Lax; Path=/` (readable by JS by design) |

No other cookies carry authority. **No tokens in `localStorage` or `sessionStorage`** —
they are readable by any successful XSS, and the session cookie is not.

## 6. Frontend hardening

- React's default escaping is the rule; `dangerouslySetInnerHTML` is banned by lint, with
  exceptions requiring review and DOMPurify.
- **Scanner output and evidence are never rendered as markup.** Escaped text, or a
  sandboxed frame on a separate origin.
- User-supplied URLs are scheme-validated before becoming an `href`; external links carry
  `rel="noopener noreferrer"`.
- Markdown (comments, remediation notes) renders through a sanitiser with a restricted
  allowlist — no raw HTML, no `javascript:` URLs.
- Errors surfaced to users are safe messages from the shared envelope; stack traces and
  internal identifiers never reach the browser.
- Source maps are not published for production application bundles.

## 7. Testing requirements

Header presence asserted on representative routes in integration tests; CSP has no
`unsafe-inline`/`unsafe-eval`; CORS rejects an unlisted origin and never reflects arbitrary
origins with credentials; cookie flags asserted; a finding whose title contains `<script>`
renders as text in the UI (Playwright); `dangerouslySetInnerHTML` count does not increase.
