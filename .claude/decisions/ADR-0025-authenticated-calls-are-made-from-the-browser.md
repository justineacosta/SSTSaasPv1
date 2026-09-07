# ADR-0025: Every authenticated API call is made from the browser, and the app shell resolves its session client-side

**Status:** Accepted · **Date:** 2026-09-07

## Context

Task 17 builds the `(app)` shell, the organisation switcher and `/settings/security` — the first
authenticated pages in this product. Task 16 built the unauthenticated ones, and it never had to
answer this question, because a login form has no session to resolve.

Two documents point in different directions, and the conflict has to be settled before the shell
is written rather than discovered afterwards:

- [`architecture/frontend.md`](../architecture/frontend.md) §2's rendering table says **"App
  shell, navigation | Server component | Permissions resolved server-side; no flash of forbidden
  UI."**
- The Phase 2 plan's Task 17 says the shell **"fetches `GET /api/v1/auth/session` once and
  provides principal, active organisation and permission set through context. TanStack Query is
  already wired and currently queries nothing; this is its first real use."**

A server component *can* do this: Next can read the incoming `__Host-session` cookie through
`cookies()` and forward it on a server-side fetch to `apps/api`. `CrossSiteGuard` allows a request
carrying neither `Origin` nor `Sec-Fetch-Site`, and `GET /auth/session` is safe so no CSRF token
is required. Nothing technical prevents it. The question is whether it is right.

## The measurement that decides it

`apps/api/src/common/guards/rate-limit.config.ts` declares two classes whose **only** scope is
`perIp`, both fail-closed:

```
passwordChange:  { perIp: { limit: 10, windowSeconds: 3600 }, failMode: 'closed' }   (line 208)
mfaManagement:   { perIp: { limit: 10, windowSeconds: 3600 }, failMode: 'closed' }   (line 303)
```

`mfaManagement` guards **four** routes — enrol, confirm, disable, regenerate recovery codes — and
`passwordChange` guards the fifth. **That is `/settings/security`'s entire feature set**, which is
to say the exact surface Task 17 builds.

If those calls originated from the Next server, every user in the product would share one source
address. The limit is not per-user and there is no per-user scope to fall back on: **ten password
changes per hour and ten MFA operations per hour for the whole deployment**, with the eleventh
user refused, because `failMode` is `'closed'`. A limiter that sees one address for the entire
internet is not a limiter — and this is not a hypothetical, it is
[ADR-0017](ADR-0017-cors-allowlist-with-credentials.md)'s third argument against a proxy, now
measured against real numbers on the real routes.

## Decision

**Every authenticated API call in `apps/web` is made from the browser, directly to `apps/api`,
including the shell's own session read. The `(app)` shell resolves the session client-side through
TanStack Query and renders a skeleton until it resolves. Permissions are not server-rendered.**

Three properties are part of this decision and not implementation detail:

- **One pattern, not two.** ADR-0017 already put the browser on a direct cross-origin call. A
  server-rendered shell would create a *second* place where a session is read and a second place
  where auth can be got wrong — and, given the limiter numbers above, the mutations would still
  have had to go from the browser. The choice was never "server or client"; it was "client, or
  client *and* server".
- **No affordance renders before the permission set is known.** §2's "no flash of forbidden UI"
  is honoured by not rendering the affordance at all until permissions arrive — a skeleton — not
  by resolving them on the server. A skeleton is a loading state, which
  `architecture/frontend.md` §6 requires on every data-bound view anyway. A flash of forbidden UI
  means rendering a button and then withdrawing it; that is banned regardless of where the data
  came from.
- **`usePermission` and `<Can>` remain UX only.** Moving the permission set into the browser
  changes nothing about authorization: every affordance is re-authorised server-side, and the API
  is what prevents an action. This ADR is about *where a read happens*, not about where a
  decision is enforced.

## Alternatives considered

**Server-render the shell, client-render the mutations.** The strongest alternative, and it is
what §2's table implies. Rejected on the two-patterns argument above: the fail-closed `perIp`
classes force every `/settings/security` mutation into the browser anyway, so this buys a
server-side read at the cost of a second session-handling path — and the read is the cheap half.
It also puts the `__Host-session` cookie through `apps/web`'s server, which is exactly the
routing authority ADR-0017 declined to give it.

**Server-render everything, including mutations, through Next server actions.** Rejected on the
measurement. It would break `passwordChange` and `mfaManagement` for every user but the first ten
each hour, fail closed, and the symptom would be an unexplained 429 on a password change — a
security control appearing to be a bug, which is how controls get disabled.

**Widen or rescope the two `perIp` classes so a proxy becomes viable.** Rejected, and worth
stating because it is the tempting inversion: it changes a security control to suit a rendering
preference. Both classes are deliberately fail-closed and deliberately IP-scoped — their
docblocks argue that an outage must not open a window in which a second factor can be turned off
at will. The UI accommodates the control, not the reverse.

**What would make us switch.** A move to a single origin (ADR-0017's own switching condition),
which would make same-origin server rendering natural and would also let the API see the real
client address through a first-party hop. Or a per-principal scope added to `passwordChange` and
`mfaManagement`, which would remove the measurement this ADR rests on — that would be a security
change with its own argument, not a side effect of a frontend preference.

## Consequences

**Positive.** One place where a session is read and one place where authenticated calls are made,
inherited unchanged from ADR-0017. The API keeps seeing real client addresses, so every `perIp`
limiter keeps working as designed. `apps/web` gains no routing authority and no cookie-forwarding
code.

**Negative, and it is a real cost paid on every authenticated page.** An authenticated page cannot
be server-rendered with its data. First paint is a skeleton, and the session round trip happens
after the HTML arrives — so there is a visible moment before navigation and permission-gated
affordances appear. This is slower than a server-rendered shell and it is the price of the
decision, not an implementation defect to be optimised away later.

**Negative.** `architecture/frontend.md` §2's table row for "App shell, navigation" is made false
by this decision and is corrected in the same change, per `CLAUDE.md`'s documentation rule. The
row was written in Phase 1, before ADR-0017 existed and before the limiter scopes were set.

**Neutral.** TanStack Query gets its first real use, which is what the plan anticipated. The
query key for the session is not organisation-scoped, deliberately — the session *is* what names
the active organisation, so scoping its key by the answer it returns would be circular.
