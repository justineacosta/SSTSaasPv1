# ADR-0023: The rate limiter runs twice — an edge pass before authentication and a tenant pass after authorization

**Status:** Accepted · **Date:** 2026-09-03

## Context

`abuse-prevention.md` §1 gives every rate-limit class a scope: `perIp`, `perPrincipal`,
`perOrganization`, or some combination. Until Task 15 the limiter was a single global guard
registered **first** in the pipeline, ahead of authentication — Task 7's ruling A and
`architecture/backend.md` §3's own table, on the argument that an unauthenticated flood carrying a
garbage cookie must be refused before it buys a Redis read and a Postgres read.

That ordering has a consequence nobody had to confront, because no shipped route had a
`perOrganization` class: **the organisation is not known that early.** It comes from
`Session.activeOrganizationId` by way of `TenantContextGuard`, which runs after authentication. So
`request.organizationId` was never populated when the limiter looked at it.

For a fail-open class that is harmless. For a fail-closed one it is fatal, and the codebase already
said so. `rate-limit.integration.spec.ts:290-296`, "refuses when a fail-closed class has no
resolvable scope", drives `@RateLimit('invitations')` on a fixture route and asserts **429** — with
the comment "there is no tenant context until Phase 2". That was correct, deliberate behaviour for
a class no route carried.

Task 15 makes `POST /api/v1/organizations/:id/invitations` the first route in this codebase to
carry one. `invitations` is `{ perOrganization: { limit: 50, windowSeconds: 86_400 }, failMode:
'closed' }` and nothing else. Shipped as it stood, **the route would have answered 429 to every
request**, including the first.

The three ways out are all decisions, which is why this is an ADR and not a bug fix.

## Decision

**Register the limiter twice, and let one table decide which scopes each pass owns.**

`RATE_LIMIT_SCOPE_PHASES` in `apps/api/src/common/guards/rate-limit.config.ts` maps every scope to
exactly one phase:

```
perIp           -> 'edge'
perPrincipal    -> 'edge'
perOrganization -> 'tenant'
```

`RateLimitGuard` keeps `phase = 'edge'` and its position as the first global guard.
`TenantRateLimitGuard` extends it with `phase = 'tenant'` and is registered **after
`AuthorizationGuard`**, so a caller the organisation's own rules refuse cannot spend the
organisation's window. `TenantContextGuard` writes the key the tenant pass reads.

Three properties, each load-bearing:

1. **Every scope belongs to exactly one phase**, so no window is charged twice for one request.
2. **`declared` counts scopes in the current phase only.** This is what keeps the fail-closed
   branch honest without a special case: a class with no scope in this phase declares nothing, so
   `declared > 0 && decisions.length === 0` is false and the request passes without issuing a Redis
   command. That is the difference between "this stage has nothing to say" and "every declared
   scope was unresolvable", and `invitations` is exactly the first shape — nothing at the edge, one
   scope in the tenant pass.
3. **The edge pass is unchanged for every existing route.** `perIp` and body-keyed `perPrincipal`
   both still resolve before authentication, so `login`, `passwordReset` and
   `emailVerificationResend` are evaluated exactly where they were.

**`perPrincipal` with `principalSource: 'authenticated'` deliberately stays at `'edge'`, where it
still resolves nothing.** That is carry-forward rulings 55 and 90 and this ADR does not close them:
`generalSession`'s 1000/min per principal remains applied to no request. Moving it would silently
switch on a limit that has never been enforced, across every authenticated route at once, inside a
change reviewed for something else. The stage it needs now exists; turning it on is a separate
decision with its own blast radius, and it should be taken deliberately rather than inherited.

## Alternatives considered

**Give the invitations route a different class.** The cheapest change, and it abandons the
requirement rather than meeting it: `abuse-prevention.md` §1 specifies 50/day **per organisation**
for invitations, and no `perIp` or `perPrincipal` window expresses that. It would also leave
`perOrganization` a scope no route can ever use, which is a dead branch in a security control.

**Move the whole limiter after tenant resolution.** Rejected, and it is the tempting one because it
is a one-line change. It repeals Task 7's ruling A: every unauthenticated flood would then buy a
session lookup in Redis and a user lookup in Postgres *before* the cheapest refusal in the pipeline
got to run. The limiter exists to be the first thing that says no.

**Resolve the organisation early, just for the limiter.** Rejected. It means reading the session
before `AuthenticationGuard` does — duplicating the lookup the ordering above exists to avoid, and
creating a second, unauthenticated path to `Session.activeOrganizationId` that would then need its
own rules about what it may conclude.

## Consequences

- **The guard pipeline is ten global guards, and the order is asserted, not documented.**
  `app.module.spec.ts` pins the full sequence and three specific relations for the new guard:
  after `TenantContextGuard`, after `AuthorizationGuard`, before `EntitlementGuard`. A reordering
  is a one-line diff to an array that changes no type and leaves every guard running, so the test
  is the only thing that would notice.
- **A fail-closed `perOrganization` class now refuses only when the tenant genuinely did not
  resolve**, rather than always. `rate-limit.integration.spec.ts:290-296` still expects 429 for its
  fixture route and still passes — but it now passes because the *tenant* pass found a declared
  scope it could not resolve, not because the edge pass could never resolve one. Its comment
  ("there is no tenant context until Phase 2") describes the old reason and is now stale.
- **Two Redis round trips are possible for one request** where a class declares scopes in both
  phases. No class does today; the cost arrives with the first one that does.
- **A request refused by any guard above the tenant pass is never counted, and for a class with no
  edge scope that means no limit at all.** Found by the adversarial review, and it is the real cost
  of this placement rather than a detail. `invitations` declares nothing in `'edge'`, so an
  authenticated caller who lacks `organization.manage_members` is refused by `AuthorizationGuard` —
  which runs *before* `TenantRateLimitGuard` — and their attempt is never charged against any
  window. They have an unlimited channel to a 403. The alternative placement, before
  `AuthorizationGuard`, has the mirror defect: a caller the organisation does not authorise could
  then spend the organisation's 50/day budget, which is a denial of service against the tenant by
  anyone holding any session in it. **The chosen order is the better of two imperfect ones**, and
  it is bounded by the fact that rulings 55 and 90 already leave every authenticated route
  effectively unlimited — closing those is what would close this.
- **`POST /api/v1/invitations/accept` cannot carry a `perOrganization` class at all.** No tenant
  resolves before its handler runs — that is the whole reason ADR-0022 exists — so the tenant pass
  has nothing to key on. Any abuse limit for that route has to be `perIp` or a body-keyed
  `perPrincipal` at the edge.
- `architecture/backend.md` §3's pipeline table and its guard count both change, in the same commit
  as this decision.
