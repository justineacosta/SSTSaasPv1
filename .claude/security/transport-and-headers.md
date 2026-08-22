# Transport security, headers, and frontend hardening

> **Status: §2 and §3 Implemented on both origins (Phase 1).**
>
> API origin — `apps/api/src/common/middleware/security-headers.middleware.ts`, registered
> with `app.use()` in `apps/api/src/app-setup.ts` and asserted header by header in
> `apps/api/src/app.integration.spec.ts`.
>
> Web origin (Task 13) — `apps/web/src/security-headers.ts`, a pure function applied by
> `apps/web/proxy.ts` to every response, unit-asserted in
> `apps/web/src/security-headers.spec.ts` and asserted again against a real HTTP response
> from a real production server in `apps/web/e2e/smoke.spec.ts`. Its three deliberate
> divergences from the API's table — no blanket `Cache-Control: no-store`, `report-uri`
> pointing at this origin's own collector, and no `Cross-Origin-Embedder-Policy` — are
> documented in that file and each has a test.
>
> §1 (edge TLS), §4 (CORS) and §5 (cookies) are Designed only: there is no edge and no
> authentication. §6 (frontend hardening) is Designed only in substance — there is no
> user-supplied content, no markdown and no evidence to render yet — though
> `productionBrowserSourceMaps: false` is set in `apps/web/next.config.ts` and React's default
> escaping applies. There is no lint rule banning `dangerouslySetInnerHTML` yet; §6 claims one
> and that claim is still ahead of the code.
>
> The `app.use()` registration is load-bearing, not a style choice. Registering the same
> middleware through Nest's `MiddlewareConsumer.forRoutes({ path: '*splat' })` resolves the
> path *under the global prefix*, so it covered only `/api/<seg>/**` and `/health/<seg>/**`:
> `/`, `/a/b`, `/healthz` and every other off-prefix path answered with no security headers and
> no `x-request-id` at all. A consumer registration also runs *after* Nest's body parser, so a
> malformed request body was rejected before the chain ran. Both are fixed, and the integration
> suite now asserts the full header set on off-prefix paths and on a body-parse failure
> specifically — the earlier assertions all picked paths inside the covered tree, which is why
> the gap survived review.

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
upgrade-insecure-requests;          <- enforcing policies only; see below
report-uri /api/v1/csp-report
```

**Do not copy that block verbatim into a report-only policy.** The one line that is not
unconditional is marked above, and the reason is the paragraph that follows.

`upgrade-insecure-requests` is emitted **only when the policy is enforcing**, and is omitted
from `Content-Security-Policy-Report-Only`. The W3C *Upgrade Insecure Requests* specification
(the standalone W3C document that defines this directive — CSP Level 2 does not) states that a
report-only policy ignores it, so sending it there changes nothing about what the browser does — but Chromium
logs `The Content Security Policy directive 'upgrade-insecure-requests' is ignored when
delivered in a report-only policy` on every response, which put a permanent console error in
every local development session (`APP_ENV=development` is report-only, per
[`../operations/environments.md`](../operations/environments.md) §4) and once presented as a
Playwright failure that was not a defect. Both origins do this — `apps/web/src/security-headers.ts`
and `apps/api/src/common/middleware/security-headers.middleware.ts` — and the unit spec beside
each asserts that the enforcing and report-only policies differ by that one directive and
nothing else.

Nonces are generated per request. `report-uri` is wired from day one and the reports are
actually read — a CSP nobody monitors is decoration. The evidence-viewer origin gets its own,
even tighter policy (`default-src 'none'; img-src 'self'; style-src 'nonce-…'`).

As shipped on the API origin, `connect-src` is `'self'`: the example hosts above name the
*web* origin's API and Sentry endpoints, and the API initiates no browser connections of its
own. **The API's `/api/v1/csp-report` collector still does not exist**, so a violation report
from the API origin gets a 404. What Task 13 added is the *web* origin's collector, at
`/api/csp-report` (`apps/web/app/api/csp-report/route.ts`), and the web origin's `report-uri`
points there rather than at the API, for two reasons.

The first is that the API's collector does not exist, so a report aimed at it would 404. The
second is that a violation report carries `document-uri` and `referrer` — this origin's own
URLs, which from Phase 2 onward identify tenants and name routes — and sending those to a
different service is a disclosure decision, not a routing detail. Same-origin collection also
happens to depend on nothing: no second service needs to be reachable for a report to land.

**A cross-origin `report-uri` would have worked.** Saying so explicitly because an earlier
version of this paragraph claimed the opposite — that CORS would have blocked it — and that
was wrong twice over. CSP violation reports are not CORS-gated: the user agent sends a
fire-and-forget POST and discards the response, with no preflight and no
`Access-Control-Allow-Origin` check in the way, which is exactly how every hosted CSP
reporting service works. And `apps/api` has no CORS configuration at all (§4 is still Designed
only), so there was no policy there to refuse anything. The divergence is a deliberate choice
between two options that both work, not a workaround for a control that does not exist.

The web collector validates the report with Zod, drops unknown keys rather than logging them,
reduces `document-uri` and `referrer` to an origin and a path before they reach the log (see
§6), and writes one `warn` line through the redacting logger. Captured verbatim from the
running dev server, which is where `apps/web/src/logger.ts` emits the pretty form rather than
JSON (`pretty: APP_ENV === 'development'`):

```
[18:18:43.837] WARN: Content Security Policy violation
    service: "web"
    cspReport: {
      "document-uri": "http://localhost:3000/invitations/:seg",
      "referrer": "http://localhost:3000/reset-password",
      "violated-directive": "script-src",
      "blocked-uri": "inline"
    }
```

The report that produced it named
`/invitations/9f8b7c6d5e4f3a2b1c0d9e8f?token=live-secret` as its `document-uri` and
`/reset-password?token=another` as its `referrer`. Neither token reached the log.

The web origin's `connect-src` is also `'self'` today. `API_BASE_URL` is a different origin
(`:3001`) in local development, so the first browser fetch to the API will need it added —
Phase 2's problem, noted here so it is not a surprise. `Cache-Control:
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
- **A CSP violation report is redacted before it is logged.** `document-uri` and `referrer`
  are URLs of *our own* pages, and `ui-ux/page-map.md` commits `(auth)` to
  `/invitations/[token]`, `/reset-password` and `/verify-email`. Browsers strip the fragment
  from `document-uri` but keep the path and the query, so an ordinary violation on an
  invitation page would write a live token into the log — CLAUDE.md rule 6. The collector
  (`apps/web/src/csp-report.ts`) therefore drops the query and fragment outright and masks any
  path segment it cannot show is a route name, keeping the origin so a report stays
  attributable. That masking is a shape heuristic, not a route table: a token that happened to
  be short, lowercase and digit-free would survive it. **Whichever phase ships the first
  token-bearing URL owes a real route-pattern mapping here** — this is a floor, not a solution.

## 7. Testing requirements

Header presence asserted on representative routes in integration tests; CSP has no
`unsafe-inline`/`unsafe-eval`; CORS rejects an unlisted origin and never reflects arbitrary
origins with credentials; cookie flags asserted; a finding whose title contains `<script>`
renders as text in the UI (Playwright); `dangerouslySetInnerHTML` count does not increase.
