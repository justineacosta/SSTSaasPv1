# ADR-0017 — The browser reaches the API directly, under an explicit CORS allowlist with credentials

**Status:** Accepted · **Date:** 2026-08-26

## Context

`apps/web` and `apps/api` are separate deployables on separate origins — `WEB_BASE_URL` and
`API_BASE_URL` are two variables in `packages/config`, and `development/setup.md` runs them on
`localhost:3000` and `localhost:3001`. Phase 2 Task 6 built the session credential as an
`HttpOnly; Secure; SameSite=Lax; __Host-` cookie, per
[`security/authentication.md`](../security/authentication.md) §3 and
[ADR-0005](ADR-0005-authentication-model.md).

A cookie is an **ambient** credential: the browser attaches it on its own, without the page
asking. That is what makes it resistant to the exfiltration that kills token-in-`localStorage`
designs, and it is also what makes cross-origin browser requests a decision rather than a
configuration detail. Task 7 builds the authentication guard, so this is the last moment at which
the answer can be chosen rather than inherited from whatever the first fetch call happens to need.

Two questions have to be answered together, because the answer to the second depends on the first:
**does the browser talk to the API directly, or through `apps/web`?** And if directly, **on what
terms?**

## Decision

**The browser calls the API directly, cross-origin, and the API declares an explicit CORS
allowlist containing exactly one entry — `WEB_BASE_URL` — with `credentials: true`, enumerated
methods, and enumerated request headers.**

Three properties are part of this decision and not implementation detail:

- **The request `Origin` is never reflected.** The allowlist is compared against a configured
  value; an origin that is not on it receives **no** `Access-Control-Allow-Origin` header at all,
  rather than a header naming itself. Reflection with `credentials: true` is equivalent to
  allowing every origin, and it is the single most common way this control is built wrong.
- **`*` is never used with credentials.** Browsers reject the combination, so the failure is
  loud rather than silent — but the rule is stated because the tempting fix for a CORS error is
  to widen the origin, and widening it to `*` here would break the product rather than open it,
  which is a confusing symptom for a real vulnerability's near neighbour.
- **CORS is not the authorization control.** It constrains what a *browser* will let a page do
  with the response. It stops nothing that is not a browser: `curl`, a server, or a scanner
  ignores it entirely. Every endpoint still declares its access (`security/authorization.md` §5)
  and every unsafe cookie-authenticated request still carries the double-submit CSRF token
  (§4). CORS is a same-origin-policy convenience layer, and treating it as a security boundary
  is how it becomes one nobody notices is absent.

## Alternatives considered

**A Next-side proxy — `apps/web` forwards `/api/*` to the API server-side.** This is the
strongest alternative and it was rejected on cost, not on correctness. Every browser request
would be same-origin, so CORS would not apply at all, the `__Host-` cookie would be first-party
in the strictest sense, and `SameSite=Strict` would become available where `Lax` is what a
cross-origin design can use. Against that:

- **It puts routing authority in `apps/web`, which otherwise has none.** Today the frontend
  renders and calls; it decides nothing about what the API exposes. A proxy makes every API route
  reachable only if `apps/web` forwards it, which means a second place where a route can be
  accidentally exposed or accidentally hidden, and a second place to keep in step with
  `/api/v1`'s versioning.
- **It adds a hop to every request, including SSE.** `architecture/overview.md` puts realtime
  updates on SSE fed by Redis pub/sub. Proxying a long-lived streaming response through Next's
  server runtime is a known source of buffering and timeout surprises, and debugging it means
  debugging two servers.
- **It obscures the client's address.** The API would see the proxy's IP on every request unless
  forwarded headers are threaded through and trusted — and `security/abuse-prevention.md` §1 keys
  half of its rate limits per IP. A limiter that sees one address for the whole internet is not a
  limiter. Trusting `X-Forwarded-For` correctly is its own security problem.

**What would make us switch.** Three things, any one of which is sufficient: a requirement for
`SameSite=Strict` on the session cookie; a decision to serve the product from a single origin
(one domain, path-split), which would make the proxy the natural shape rather than an added one;
or a third-party integration whose browser SDK cannot be made to work cross-origin with
credentials. If we do switch, this ADR is superseded rather than edited, and the CSRF control
stays regardless — a same-origin proxy does not remove the need for it, it only removes CORS.

**Reflecting the `Origin` header when it matches a pattern.** Rejected. A regular expression over
origins is a well-known source of subdomain-takeover and suffix-match bugs (`evil-webapp.com`
matching a pattern intended for `webapp.com`). An exact string comparison against one configured
value has no such failure mode, and this product has exactly one web origin per environment.

**Allowing a list of origins for convenience in development.** Rejected as a default. The one
allowed origin is `WEB_BASE_URL`, which is already environment-specific, so a developer changing
ports changes one variable that `packages/config` validates. A second mechanism for "extra
allowed origins" is a mechanism that reaches production with a value in it.

## Consequences

**Positive.** One configured origin, compared exactly, with no pattern language and no
reflection. The API keeps routing authority over its own surface. The client's real address
reaches the rate limiter. The failure mode of a misconfiguration is a blocked request in a
browser console, which is loud and local, rather than a silently widened trust boundary.

**Negative.** `SameSite=Strict` is not available to us — a cross-origin XHR would not carry a
`Strict` cookie — so `Lax` plus the double-submit CSRF token is doing the work that `Strict`
would otherwise contribute to. This is exactly why `security/authentication.md` §4 says
`SameSite=Lax` is "the baseline, not the control". Preflight `OPTIONS` requests add a round trip
for any request carrying `X-CSRF-Token`, which is every unsafe method.

**Neutral.** The allowlist is a single environment variable that already exists and is already
validated for scheme (`http`/`https`, per Task 5's ruling 48). Adding a second web origin later —
a marketing site on another domain that calls the API — is a deliberate change to a list, which
is the property we want.
