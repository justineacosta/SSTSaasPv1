# Task 17 — adversarial review

> **A dated record of what was found at review time. Not a description of current state —
> [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

Fresh adversarial reviewer, 2026-09-07. Branch `feat/phase-2-task-17-app-shell`, range
`5dbab4e..HEAD` (commits `6118952..7463389`). The reviewer did not write this code.

Written incrementally from the first minutes and committed as it went (ruling 131).

## Status: IN PROGRESS

A second reviewer picked this up on 2026-09-07 after the first was ended by a session limit
partway through. It did not redo the first reviewer's work; the sections below say who did what.

## Pass 1 — citation (COMPLETE — reviewer 1)

## Pass 2 — code (IN PROGRESS — reviewer 2)

- §1 cross-user isolation — **complete** (reviewer 1, seven probes)
- §2 the audit deviation — facts complete (reviewer 1); **verdict written** (reviewer 2)
- §3 the rate-limit choice — complete (reviewer 1, finding C-3)
- §4 the frontend — **reviewer 2**
- §5 documentation made false — **reviewer 2**

## Findings (C-1..C-3 reviewer 1; C-4 onward reviewer 2)

## Checked and found fine (in progress)

---

## Pass 1 — citation. Do the reported numbers reproduce?

Every command re-run by the reviewer at the repository root on `HEAD` of
`feat/phase-2-task-17-app-shell`, exit code captured outside a pipe, compose stack up
(`sentinel-postgres-1`, `sentinel-redis-1`, `sentinel-minio-1`, `sentinel-mailpit-1`, all
`Up (healthy)`).

| Report claim | Reviewer's re-run | Verdict |
|---|---|---|
| `pnpm test` 0, 115 files / 1970 tests | exit 0, **115 files / 1970 tests** | reproduces |
| `pnpm check:specs` 0, 144 spec files | exit 0, **"144 spec files, each claimed by exactly one of: unit, integration, ui"** | reproduces |
| `pnpm check:openapi` 0, 29 routes, byte-identical | exit 0, `"routes":29`, **"byte-identical to what the contracts generate"** | reproduces |
| `pnpm check:registry` 0, 15 models / 3 tenant-owned / 1 tenant root / 11 global | exit 0, **"15 models, 3 tenant-owned, 1 tenant root, 11 deliberately global"** | reproduces — `Session` did **not** drift into the tenant registry |
| `pnpm check:secrets` 0, 520 tracked files | exit 0, **"520 tracked files, no credential-shaped literals"** | reproduces |
| 29 OpenAPI paths, session routes are `/auth/session`, `/auth/sessions`, `/auth/sessions/{sessionId}` | `node -e` over `apps/api/openapi.json`: **29**, exactly those three | reproduces |

Other Step-2/Step-3 claims opened and confirmed:

- `logout.service.ts:56-73` really does carry the "audit row is NOT in the same transaction"
  compromise, with the same revoke-then-audit ordering and the same reasoning. **The precedent is
  real, not merely similar.**
- `logout.service.ts:84-86` discards `revoke`'s boolean and audits unconditionally;
  `session-management.service.ts:177-183` audits only on `'REVOKED'`. **The "stricter than logout"
  claim is true.**
- Cookie clearing at `auth.controller.ts:789` is byte-identical to `logout`'s at `:514`
  (`response.setHeader('Set-Cookie', [clearedSessionCookie(), clearedCsrfCookie()])`). The end
  state genuinely matches `POST /auth/logout`; there is no half-cleared pair.
- `app-setup.ts:127` installs exactly one global interceptor (`LoggingInterceptor`). No response
  is validated against a contract schema anywhere. See finding C-1.
- No guard, middleware or interceptor sets a session cookie — only `auth.controller.ts` does
  (grep for `Set-Cookie`/`setHeader` across `apps/api/src`), so nothing can overwrite the cleared
  pair after the handler returns.
- Bulk revocation's "tombstoned before the rows are written" is true: `session.service.ts:885-895`
  runs **two** poison passes and the first precedes the `updateMany`. Checked because
  `revokeLiveForUser` reads hashes back *after* the write and the ApiDoc claim looked false; it
  is not.

---

## Findings

### C-1 (Citation, and it is the report's own most-repeated claim) — `sessionSummarySchema` is NOT an enforcer on the API side. There are two strippings, not three, and the contract docblock states a false security property.

**Citation.** `packages/contracts/src/auth.ts:271-294` (the `sessionSummarySchema` docblock):

> "Here the shape is closed, so the hash is not merely omitted — **it is unrepresentable on the
> wire**, and `check:openapi` pins that."

and `report.md` Step 6, "The one survivor, explained rather than explained away":

> "`tokenHash` is stripped **three** times on the way out — `SessionService.listOwnedPage` projects
> to `OwnedSession`, `AuthController.listSessions` builds each row field by field, and
> `sessionSummarySchema` closes the shape."

**Measurement.**

1. `apps/api/src/app-setup.ts:127` installs exactly one global interceptor, `LoggingInterceptor`.
   `grep -rn "APP_INTERCEPTOR\|useGlobalInterceptors" apps/api/src` returns those two lines and
   nothing else. **No response is parsed against a contract schema anywhere in `apps/api`.**
   `ZodValidationPipe` is applied to `@Body`, `@Query` and `@Param` only.
2. `sessionSummarySchema` is a plain `z.object`, not `.strict()` — contrast
   `switchOrganizationRequestSchema` at `packages/contracts/src/auth.ts:328`, which *is*. Even if
   it were parsed, non-strict Zod strips silently rather than refusing.
3. **The implementer's own mutation 7b is the proof.** Widening the service *and* the controller
   put `tokenHash` on the wire and the integration test failed with
   `expected '{"data":[{"id":"ses_…' not to contain 'tokenHash'`. If the schema were the third
   enforcer, that mutation could not have reached the response body. A schema that a two-layer
   mutation defeats is not a third layer.
4. `check:openapi` pins the *document*, not the runtime: it compares `apps/api/openapi.json` byte
   for byte against what the contracts generate. It cannot observe a response body.

**Why it matters rather than being pedantry.** The brief instructed: "A response schema in
`packages/contracts` is what enforces this — add one, **and do not hand-roll the shape in the
controller**." What shipped is the opposite: the hand-rolled controller mapping at
`auth.controller.ts:621-637` is one of the two real enforcers, and the schema is documentation.
The behaviour is currently correct; the *belief about why* is wrong, and it is written into a
docblock a future maintainer will trust. A maintainer who reads "unrepresentable on the wire" and
then simplifies `listSessions` to `page.sessions.map(s => ({...s}))` — a change that typechecks,
because TypeScript does not excess-property-check a spread — ships the hashed credential and no
test in the repository fails except the one integration assertion.

**Severity: Citation** on the false sentences, **Medium** on the shape of the defence they
describe. Not Critical: nothing is broken today, and the browser client at
`apps/web/src/api/client.ts:162` does `responseSchema.safeParse(body)`, whose non-strict Zod
output genuinely strips extras — so the schema *is* an enforcer on the **client**, which is
probably where the belief came from.

### C-2 (Medium) — revoking the CURRENT session from `/settings/security` leaves the browser in the state the API decision was justified by *not* producing.

**Citation.** `apps/web/src/settings/SessionsPanel.tsx:51-57`:

```
const revokeOne = useMutation({
  mutationFn: (sessionId: string) => revokeSession(client, sessionId),
  onSuccess: () => {
    void queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
  },
});
```

and `SessionRow` at `:213-217`, which renders "Sign out this device" for `session.current` and
wires it to the same `onRevoke`.

**Measurement.**

- `auth.controller.ts:766-790` clears both cookies when `wasCurrent`, and the decision docblock at
  `:733-746` justifies allowing it on the grounds that "the end state is one this API already
  produces — it is `POST /auth/logout` by another route".
- `AppShell.tsx:151-166` shows what the app does for that end state: `await logout(client)`, then
  **`queryClient.clear()` and `router.replace('/login')`**.
- `SessionsPanel`'s current-session revocation does **neither**. It invalidates one query key, the
  refetch 401s, and the panel renders "Your sessions could not be loaded. Try again in a moment."
  (`SessionsPanel.tsx:86-88`). `AppShell`'s 401 redirect is keyed on `useSessionQuery`
  (`AppShell.tsx:88-97`), which is already resolved in cache and is never refetched by this path,
  so the shell keeps rendering the signed-in chrome.
- `grep -n "it(" apps/web/src/settings/SessionsPanel.spec.tsx` lists twelve tests. **None covers
  revoking the current session.** The nearest, `:123` "labels the current session differently, so
  it is not signed out by accident", asserts the *label*, not the outcome.

The user is signed out on the server and signed-in-looking in the browser until they reload —
which is the exact symptom the review brief named ("a signed-in-looking app that 401s on
everything"). It is reached by a different route than the one the brief anticipated: the cookies
are correctly cleared, the *client* is what does not react.

Not High: no other user's data is exposed, the stale view is the caller's own, and a reload
recovers correctly (the session query 401s and `AppShell` redirects). But the API-side decision
was argued on an equivalence with `logout` that the only UI able to exercise it does not deliver.

### C-3 (Low) — the "no oracle" claim in §3's rate-limit argument is true of the body and not quite true of the clock.

**Citation.** `auth.controller.ts:591-594` and `report.md` Step 2: "every refusal for an id that
is not the caller's is the same 404."

**Measurement.** The body claim holds and is asserted as an identity, not two expectations:
`auth.sessions.integration.spec.ts:148` compares `refusalWithoutRequestId(foreign.body)` to
`refusalWithoutRequestId(absent.body)` with `toEqual`, and `refusalWithoutRequestId` at `:126-131`
strips only `requestId`. That is a good test and it passes.

The timing claim is weaker than stated. `session.service.ts:783-790`:

```
const row = await this.repository.findById(sessionIdSchema.parse(sessionId));
if (row === null) return 'NOT_FOUND';
if (row.userId !== userIdSchema.parse(userId)) return 'NOT_FOUND';
```

An id that names no row is an index probe that returns nothing; an id that names somebody else's
row is an index probe that returns a full `SessionRow` (nine columns including `tokenHash`) over
the wire protocol, deserialised by Prisma, plus a `userIdSchema.parse`. The docblock at `:770-775`
asserts "the database round trip that precedes this line dominates any timing signal" — that
argument is about the `!==` comparison, and the difference here is not the comparison, it is
whether a row was fetched at all. With `generalSession` resolving nothing
(`rate-limit.config.ts:372-381`), an attacker may average over unlimited samples.

**Why Low and not higher:** the oracle needs a candidate id, and `ses_` ids are ULIDs — an
attacker cannot generate candidates. It is only useful for *confirming* an id obtained elsewhere
(a leaked log line, an audit export, a support transcript), which is a narrow real case. Reported
because §3 of the review brief asked whether "no oracle" is true of **every** response including
timing, and the honest answer is "of the body yes, of the clock approximately".

### C-1, the decisive measurement

The reviewer applied its own mutation — the realistic one, not a contrived one: replace both
hand-written projections with a spread.

```
session.service.ts  listOwnedPage:  sessions: page.map((row) => ({ ...row })),
auth.controller.ts  listSessions:   data: page.sessions.map((session) => ({
                                      ...session,
                                      createdAt: session.createdAt.toISOString(),
                                      lastSeenAt: session.lastSeenAt.toISOString(),
                                    })),
```

| Command | Exit | Output |
|---|---|---|
| `pnpm --filter @sentinel/api exec tsc --noEmit` | **0** | **no error at all — TypeScript does not excess-property-check a spread, so nothing at compile time objects to shipping the hashed credential** |
| `pnpm vitest run --project integration apps/api/src/modules/auth/auth.sessions.integration.spec.ts` | 1 | 1 failed / 22 passed — `AssertionError: expected '{"data":[{"id":"ses_01M1XFTZXJF7XTYKH…' not to contain 'tokenHash'` |

Reverted with `git checkout --`; `git status --short` afterwards shows only the reviewer's own
probe file.

So: **one assertion in the entire repository stands between this endpoint and a hashed credential
on the wire** — `auth.sessions.integration.spec.ts:222`. That is a good test and it is doing its
job. It is not "three independent strippings", and it is not "unrepresentable".

### Reviewer's own probe — seven attacks on the isolation, all repelled

The reviewer wrote `apps/api/src/modules/auth/reviewer-probe.integration.spec.ts` (deleted before
the final commit; it is not part of the branch) to attack shapes the implementer's suite does not
cover. `pnpm vitest run --project integration …` → **exit 0, 7 passed**.

| Probe | Result |
|---|---|
| A — another user's **already-revoked** session id | 404 `RESOURCE_NOT_FOUND`, not 200 |
| B — another user's **`PENDING_MFA`** session id | 404, and `revokedAt` still `null` afterwards |
| C — a `PENDING_MFA` row hidden from **its own owner** | hidden from the list, and once the warm cache entry is dropped the credential answers **401** |
| D — a **forged cursor** positioned over another user's rows | 200, and the other user's row is absent — the `userId` scope is inside the predicate, so no cursor widens the set |
| E — a **refused** revocation | audit row count unchanged: a 404 writes nothing |
| F — every `SESSION_REVOKED` audit row | contains neither the string `tokenHash` nor any stored hash value |
| G — an id from **another prefix namespace** (`usr_…`) | 400 `VALIDATION_ERROR`; a well-formed foreign id is 404 |

**Probe C is worth recording because it failed first and the failure was the probe's.** Mutating
`status` to `PENDING_MFA` in Postgres alone left `GET /auth/session` answering **200**, because
`SessionService.resolve` (`session.service.ts:511-546`) serves from the Redis snapshot and never
re-reads `status`. That is a test artefact, not a defect: a real `PENDING_MFA` session is refused
by `AuthenticationGuard` at `authentication.guard.ts:195-206` with 401 `MFA_REQUIRED`, and
`auth.controller.ts:432` sets **no cookie at all** for a pending credential, so one can never
arrive in `__Host-session` by the product's own paths. **Decision 5's premise holds: an excluded
session genuinely cannot authenticate a request.**

---

# Reviewer 2 — picking up at §4 and §5 of the brief

The first reviewer's citation pass, cross-user isolation probes and findings C-1 to C-3 stand and
are not repeated. What follows is the part of the brief that had not been reached: the frontend
(§4), the documentation list (§5), and the explicit verdict on §2's audit deviation.

## C-4 (HIGH) — `queryClient.clear()` empties the store but does not repaint the screen. After an organisation switch the shell keeps rendering the PREVIOUS organisation — its name, its permission set, and any page data keyed without an organisation — until the user navigates or reloads.

This is the exact property `architecture/frontend.md` §3 is written to protect, quoted by
`OrganizationSwitcher.tsx`'s own docblock: *"Switching organisations clears the cache entirely — a
stale cross-tenant render would be a security-visible bug even though the data was legitimately
fetched."* The cache is cleared. The render is stale anyway.

**Citation.** `apps/web/src/app/OrganizationSwitcher.tsx:47-56`:

```
const switcher = useMutation({
  mutationFn: (organizationId: string) => switchOrganization(client, { organizationId }),
  onSuccess: (next) => {
    queryClient.clear();
    queryClient.setQueryData(SESSION_QUERY_KEY, next);
  },
});
```

and `apps/web/src/app/session-context.tsx:104-112`, where `useSessionQuery` is the observer that
feeds `SessionContextProvider` in `AppShell.tsx:128`.

### Measurement 1 — the real shell, the real switcher, the real `clear()`

Probe `apps/web/src/app/reviewer-cache.spec.tsx` (deleted before this review's final commit; not
part of the branch) mounts `<AppShell><Page/></AppShell>` against a `stubClient` whose
`/api/v1/auth/session`, `/api/v1/organizations`, `/api/v1/auth/switch-org` and a
`/api/v1/findings` all answer for **whichever organisation the session currently names** — which
is what the real API does, since the organisation is on the cookie and not in the URL. The
organisation is then switched from Acme to Globex through the real `<select>`, with
`userEvent.selectOptions` (act-wrapped).

`pnpm vitest run --project ui apps/web/src/app/reviewer-cache.spec.tsx` — **2 of 3 failed**:

```
P1 immediately after clear  | Acme on screen: true | Globex on screen: false | cache['findings']: undefined
P1 100ms later              | Acme on screen: true | Globex on screen: false | cache['findings']: undefined
P2 context org rendered  : org:acme | select value: org_...GQ7 (ACME)
   | cache session: {"activeOrganization":{"id":"org_...GQ9","slug":"globex","name":"Globex"},...}
P2 150ms later              | Acme on screen: true | Globex on screen: false | cache['findings']: undefined

AssertionError: expected <li></li> to be null
- Expected: null
+ Received: <li>Acme's finding</li>
```

Read the P2 line carefully, because it is the whole finding: **the cache holds Globex and the
screen renders Acme.** The organisation `<select>` still shows Acme, so the switcher does not even
report the switch it performed. The page's own instrumentation shows why:

```
[page render] contextOrg=acme findings=undefined status=pending/fetching
[page render] contextOrg=acme findings={"rows":["Acme's finding"]} status=success/idle
   <- the switch happens here, and there is no third render. Ever.
```

**Two renders, both before the switch.** After the switch the shell does not re-render, the page
does not re-render, and `['findings']` — cleared — is never refetched, so the row stays on screen
with nothing behind it. The server session has already moved to Globex: every request the user
makes from this point is answered for the *other* tenant while the chrome names the first one.

### Measurement 2 — the mechanism, with no Sentinel code in the frame

Probe `apps/web/src/app/reviewer-observer.spec.tsx` (also deleted): one `useQuery(['session'])`,
one button whose handler is `OrganizationSwitcher`'s `onSuccess` body verbatim (`clear()` then
`setQueryData()`), nothing else.

| Probe | Result |
|---|---|
| **A** — nothing else re-renders the observing component | `hook renders "acme" \| cache holds {"org":"globex"} \| Probe re-rendered **0** time(s) since the switch` |
| **B** — an unrelated parent state update re-renders it | the render log shows `[render 3] useQuery.data={"org":"globex"}` — it recovers, and only then |

The library reason, read out of `@tanstack/query-core@5.101.4` (the installed version):

- `queryClient.clear()` → `queryCache.clear()` → for every query `remove(query)`, which calls
  `query.destroy()` and deletes it from the map (`queryCache.js:39-55`).
- `query.destroy()` is `super.destroy(); this.cancel({ silent: true })` (`query.js:86-89`).
  **It does not touch `query.observers`, and `silent: true` suppresses any dispatch.**
- A `QueryObserver` subscribes to its *query*, not to the cache: `#currentQuery` is reassigned
  only inside `#updateQuery()` (`queryObserver.js:417`), reachable only from `setOptions` /
  `onSubscribe` — i.e. **only when React re-renders the hook**. `grep -rn "queryCache.subscribe"`
  across `query-core`'s build returns nothing.
- So after `clear()` every mounted observer holds a destroyed query that is no longer in the
  cache, and `setQueryData` writes into a *newly built* query that has **zero** observers.

A window-focus refetch does not rescue it either: `queryCache.onFocus()` iterates `this.getAll()`
(`queryCache.js:79-85`) — the orphaned query is not in that list, and the rebuilt one has no
observers to fetch for.

### Why the shipped tests cannot see it

`OrganizationSwitcher.spec.tsx:47-52` renders the switcher under a **static**
`SessionContextProvider session={sessionOn(ORG_A, ...)}` — a literal prop, never
`useSessionQuery`'s observer. Every assertion in that file is against
`queryClient.getQueryData(...)`, and the spec says so deliberately at `:63-68`: *"The assertion is
against the cache itself rather than against what happens to be on screen."* That choice is
defensible against the failure it was aimed at, and it is exactly what hides this one — **the
cache is the half that works.**

`AppShell.spec.tsx` has nine tests and none of them switches organisations
(`grep -n "it(" apps/web/src/app/AppShell.spec.tsx`). `e2e/app-shell.spec.ts` has seven and none
of them signs in, so none reaches a switcher with more than one organisation in it. There is no
test in this repository that mounts the shell and changes organisation.

### Severity

**High**, and it is the one High in this review.

- It is the named `frontend.md` §3 property, failing in the direction that document calls
  "security-visible".
- It is not a leak across a permission boundary — the rows on screen are ones this user was
  entitled to see a moment ago — which is the only reason it is not Critical.
- But the shell's `permissions` array is frozen on the previous organisation too, so every
  `usePermission` / `<Can>` gate under it is evaluated against the wrong tenant's rights until the
  next navigation. Those are UX-only (see C-6), so this misinforms rather than authorises.
- It persists indefinitely. Nothing in the app recovers it except a route change or a full page
  load; the `refetchOnWindowFocus: true` at `app/providers.tsx:44` does not.
- The mitigation the implementer chose and argued for at length — a total clear, no per-key
  reasoning — is the thing that produces it. `router.refresh()`, a remount key on the shell, or
  `resetQueries()` in place of `clear()` would each have re-rendered. `clear()` alone does not.

**Answering the brief's §4 question directly** — "verify the clear is total and that nothing
survives it (router cache, in-flight requests, an unmounted component's stale closure)":

| Asked about | Answer | Evidence |
|---|---|---|
| The query store | **Total.** Both shipped assertions reproduce; nothing survives `clear()` | `OrganizationSwitcher.spec.tsx`, re-run green |
| Next's router cache | **Empty of tenant data, so nothing to clear.** Every page under `(app)` renders its data from client queries; `app/(app)/layout.tsx`, `dashboard/page.tsx`, `settings/*/page.tsx` fetch nothing server-side (ADR-0025), and every route is `ƒ (Dynamic)` | read all four files; `grep` for a server-side fetch returns nothing |
| In-flight requests | **Fine.** `clear()` cancels each retryer, and a request that resolves anyway writes into a Query object already removed from the map — probe P3 ended with `cache['findings']: undefined` and neither tenant's row on screen | probe P3, passed |
| A stale closure / stale render | **BROKEN — this finding.** Not a closure: an orphaned `QueryObserver` | probes P1, P2, A, B |
