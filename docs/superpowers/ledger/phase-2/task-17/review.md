# Task 17 — adversarial review

> **A dated record of what was found at review time. Not a description of current state —
> [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

Fresh adversarial reviewer, 2026-09-07. Branch `feat/phase-2-task-17-app-shell`, range
`5dbab4e..HEAD` (commits `6118952..7463389`). The reviewer did not write this code.

Written incrementally from the first minutes and committed as it went (ruling 131).

## Status: COMPLETE

A second reviewer picked this up on 2026-09-07 after the first was ended by a session limit
partway through. It did not redo the first reviewer's work; the table below says who did what.
Every section of the review brief has now been covered.

| Brief section | State | By |
|---|---|---|
| Pass 1 — citation | **COMPLETE** — every reported number reproduces | reviewer 1 |
| §1 cross-user isolation | **COMPLETE** — seven attack probes, all repelled | reviewer 1 |
| §2 the audit deviation | **COMPLETE** — facts, then the explicit verdict (ACCEPT) | facts reviewer 1, verdict reviewer 2 |
| §3 the rate-limit choice | **COMPLETE** — finding C-3 | reviewer 1 |
| §4 the frontend | **COMPLETE** — findings C-4, C-5, C-6 | reviewer 2 |
| §5 documentation made false | **COMPLETE** — finding C-7 | reviewer 2 |

## Findings: C-1 to C-3 (reviewer 1), C-4 to C-7 (reviewer 2). Summary table at the end of this file.

## Checked and found fine: reviewer 1's list is in its Pass 1 section; reviewer 2's is under "Checked and found FINE" near the end.

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

## C-5 (Low) — `/settings/members` tells a member without `organization.manage_members` that they "can see who belongs to this organisation". They cannot: both list routes answer 403, and the screen renders that sentence underneath its own error alert.

**Citation.** `apps/web/src/settings/MembersScreen.tsx:189-199`:

```
{canManageRoles && canManageMembers ? null : (
  <p …>
    {canManageMembers
      ? 'You can invite and remove members. Changing a role needs organization.manage_roles, …'
      : 'You can see who belongs to this organisation. Inviting, removing and changing roles need
         organization.manage_members, …'}
  </p>
)}
```

against `apps/api/src/modules/memberships/memberships.controller.ts:84`
(`@RequirePermission('organization.manage_members')` on the `@Get()` list) and
`apps/api/src/modules/invitations/invitations.controller.ts:211` (the same permission on *its*
`@Get()`). The API's own `ApiDoc` at `memberships.controller.ts:89` says it in words: "Requires
`organization.manage_members`."

**Measurement.** Probe `apps/web/src/settings/reviewer-members.spec.tsx` (deleted before this
review's final commit) renders `<MembersScreen>` for a session with `permissions: []` against a
client that answers **403 `PERMISSION_DENIED`** to every call — which is exactly what those two
handlers do for that session — and prints `document.body.textContent`:

```
---- WHAT THE USER SEES ----
Members
Who belongs to this organisation, what they may do, and who has been invited.
Members
The member list could not be loaded. Try reloading the page.
You can see who belongs to this organisation. Inviting, removing and changing roles need
organization.manage_members, which an owner or admin can grant.
Invitations
Inviting somebody needs organization.manage_members. An owner or admin can grant it.
Outstanding invitations could not be loaded.
----------------------------
```

Three things are wrong in six lines:

1. **"You can see who belongs to this organisation" is false** — the list it refers to is the one
   that just 403'd, two lines above.
2. **A 403 is reported as a transient failure with the wrong remedy.** "Try reloading the page"
   will fail identically forever. `MembersScreen.tsx:149-153` renders one `members.isError` branch
   with no discrimination on `ApiError.status`, and the same at `:410-414` for invitations.
3. `architecture/frontend.md` §6 asks for a permission state that *"explains the missing permission
   rather than showing a blank page"*. The screen has such a state — the paragraph at `:191` — and
   it is the sentence that is wrong, while the error alert that dominates the page has no idea a
   permission is involved.

The dashboard repeats the claim to everyone: `app/(app)/dashboard/page.tsx:60-70` — "Invite
people, change their roles and remove them on Members" — with no gate.

**Severity: Low.** Nothing is exposed and nothing is authorised that should not be; the server
refuses correctly and the refusal is what the user hits. It is a false sentence in shipped UI,
which in this repository is the recurring defect class rather than a cosmetic one, and it is
reachable by any member whose role is not owner/admin — i.e. by the common case.

**Not a defect, checked and rejected:** the role `<select>` is gated on `canManageRoles`
(`MembersScreen.tsx:240-248`) while removal is gated on `canManageMembers` (`:253`), and the API
splits them exactly the same way — `manage_roles` on `@Patch(':membershipId')`
(`memberships.controller.ts:135`), `manage_members` on `@Delete(':membershipId')` (`:221`). The two
gates match their two routes. The `canManageMembers ? …` branch of the paragraph is correct.

---

## C-6 — `usePermission` and `<Can>`: the brief's §4 question answered, and the answer is FINE

The brief required "a docstring saying so in those words". It is there, twice, verbatim:

- `apps/web/src/app/session-context.tsx:53` — `WHETHER THE UI SHOULD OFFER AN ACTION. **THIS IS UX
  ONLY, NOT SECURITY.**`
- `:70` — `**UX only, not security** — the same sentence as usePermission above, and for the same
  reason. A <Can> that wraps a button hides the button; the server is what refuses the request the
  button would have made.`

**No code path treats either as a control.** `grep -rn "usePermission\|<Can" apps/web/src apps/web/app`
outside `session-context.tsx` returns six lines, all in `MembersScreen.tsx` and one comment in
`SecurityScreen.tsx`. Every one wraps a rendered affordance. Neither is used in a `queryFn`, a
`mutationFn`, an endpoint module, a route file, or a `middleware.ts`; neither gates a request being
*sent*, only a control being *drawn*.

**Every gated affordance is still refused server-side**, checked route by route against
`apps/api/openapi.json` and the decorators:

| UI affordance | Gate in the browser | Route | Server decorator |
|---|---|---|---|
| Change a member's role | `canManageRoles` (`MembersScreen.tsx:246`) | `PATCH /organizations/{id}/members/{membershipId}` | `@RequirePermission('organization.manage_roles')` — `memberships.controller.ts:135` |
| Remove a member | `canManageMembers` (`:253`) | `DELETE /organizations/{id}/members/{membershipId}` | `@RequirePermission('organization.manage_members')` — `:221` |
| The invite form | `<Can permission="organization.manage_members">` (`:314`) | `POST /organizations/{id}/invitations` | `@RequirePermission('organization.manage_members')` — `invitations.controller.ts:133` |
| Revoke an invitation | `<Can permission="organization.manage_members">` (`:378`) | `DELETE /organizations/{id}/invitations/{invitationId}` | `@RequirePermission('organization.manage_members')` — `:262` |

`MembersScreen.tsx:44-47` also names the two refusals *no* permission set predicts — granting a
role whose permissions the caller lacks, and a write that would leave the organisation ownerless —
and renders them where the user can read them (`:167`, `refusal`). That is the right shape: the
gate is a hint, the server is the answer, and a refusal the hint did not anticipate is displayed
rather than swallowed.

The one thing C-4 does to this: after an organisation switch the `permissions` array these gates
read is the previous organisation's, so they are computed from the wrong tenant's rights until the
next navigation. Because they are UX only, that misinforms the user; it does not authorise
anything.

## C-7 (Medium — the brief said "a missed document is the defect") — the report's §5 list misses one document entirely, is wrong about a second, and gets the arithmetic wrong in two of the four it does name.

The brief asked: *"Verify that list is right and complete."* It is neither. Each item below is a
count run against the repository, not a reading.

### C-7a — MISSED DOCUMENT: `.claude/security/abuse-prevention.md`

Its banner, lines 14-19:

> **`generalSession` governs eight routes**, each carrying `@RateLimit('generalSession')`
> explicitly rather than by default: the five organisation routes, `POST /api/v1/auth/switch-org`,
> `POST /api/v1/auth/logout` and `GET /api/v1/auth/session`. … Counted from
> `grep -rn "@RateLimit('generalSession')" apps/api/src --include=*.ts`

The three new session routes all carry `@RateLimit('generalSession')`
(`auth.controller.ts:596`, `:673`, `:740`) — the class the implementer chose, argued for, and had
the orchestrator's brief corrected about. This document is the one that enumerates that class's
members, it pins its own count to a named command, and it is **absent from the report's list**.

**Measurement**, running the document's own command:

| | Result |
|---|---|
| `git grep -c "@RateLimit('generalSession')" 5dbab4e -- apps/api/src` (base, non-spec) | 3+1+2+3+5+1 = **15** |
| the same grep on `HEAD` | **18** — the three added lines are `auth.controller.ts:596, 673, 740` |
| the document | **"eight"** |

Note the second-order point: it was already wrong before this task (15, not 8), so the orchestrator
does not owe an increment of three — it owes a recount. But it is Task 17 that makes the routes it
enumerates by name incomplete, and Task 17's report is the one that was asked to find it.

### C-7b — WRONG: `.claude/security/audit.md`. The report says nothing is owed. Something is.

Report item 5: *"`.claude/security/audit.md` §4 already lists `SESSION_REVOKED`, so nothing is owed
there — but the note in the surrounding prose that some names are written by no code is now one
name shorter."*

There is no such note in the surrounding prose. The claim lives in the document's **status
banner**, line 13, and it is a number:

> **Four actions in §4 are written by running code**; every other name in that section is still
> Designed only. `USER_REGISTERED`, `REGISTRATION_BLOCKED_EXISTING_EMAIL`,
> `EMAIL_VERIFICATION_RESENT` and `EMAIL_VERIFIED` …

`SESSION_REVOKED` is written by running code as of this task and was written by none before it:

```
$ git grep -n "SESSION_REVOKED" 5dbab4e -- apps/api/src      # (nothing)
$ grep -rn "SESSION_REVOKED" apps/api/src --include=*.ts | grep -v spec
apps/api/src/modules/audit/platform-audit.actions.ts:308
apps/api/src/modules/auth/session-management.service.ts:231   ← the writer
```

So the banner is falsified by this task, and it is a **status banner**, which is the class of
sentence this repository treats as load-bearing. (Like C-7a it was already stale — `LOGIN`,
`LOGOUT`, `ACCOUNT_LOCKED`, the `PASSWORD_*` and `MFA_*` names have had writers since Tasks 9-11 —
and its second sentence, "Nothing writes an `AuditEvent` row yet", has been false since Task 13.
The orchestrator owes a recount here too.) The report's "nothing is owed there" is the sentence
that is wrong.

### C-7c — ARITHMETIC: `api/authorization.md`'s non-permission route count is not "four"

Report item 4: *"This task adds three more `@AuthenticatedOnly()` routes, so that banner's count of
deliberate non-permission routes is now four rather than one."*

**Measurement** — counting route decorators, not docblock mentions:

| | `@AuthenticatedOnly()` routes |
|---|---|
| base `5dbab4e` | **11** — `auth.controller.ts` 8, `invitation-acceptance.controller.ts` 1, `organizations.controller.ts` 2 |
| `HEAD` | **14** — the same plus `GET /auth/sessions`, `DELETE /auth/sessions`, `DELETE /auth/sessions/:sessionId` |

Enumerated on `HEAD`: `POST /auth/logout`, `GET /auth/session`, `GET /auth/sessions`,
`DELETE /auth/sessions`, `DELETE /auth/sessions/{sessionId}`, `POST /auth/switch-org`,
`POST /auth/change-password`, `POST /auth/mfa/enroll`, `POST /auth/mfa/confirm`,
`POST /auth/mfa/disable`, `POST /auth/mfa/recovery-codes`, `POST /invitations/accept`,
`POST /organizations`, `GET /organizations`.

So the correct figure is **eleven becoming fourteen**, not one becoming four. The banner's phrasing
("An eleventh route exists and declares no permission on purpose") uses "eleventh" as an ordinal
after the ten permission-declaring routes, not as a count of non-permission routes — the report
read it as the latter and produced a number that is wrong by a factor of three and a half. An
orchestrator editing the banner from this report writes a new false sentence.

Related and worth stating so the orchestrator does not chase it: `architecture/backend.md:99`
("governs ten shipped routes as of Task 15") and `security/authorization.md:301` (the same phrase)
are **not** falsified — the three new routes declare no permission, so the count of
`@RequirePermission()` routes is still ten and `EXPECTED_GUARDED_ROUTES` is untouched by this
branch.

### C-7d — ARITHMETIC: `api/authentication.md` §7's table is seventeen rows only if you accept an existing omission

Report item 3: *"Its §7 rate-limit table lists fourteen routes and is now seventeen."*

Fourteen rows reproduce (`awk 'NR>=360 && NR<=420 && /^\| \`/' .claude/api/authentication.md | wc -l`
→ **14**), and the prose above them says "The fourteen routes that exist carry:". But
`auth.controller.ts` held **fifteen** routes at base and holds **eighteen** now
(`grep -cE "^  @(Get|Post|Patch|Delete|Put)\(" `). The missing one is
**`POST /auth/switch-org`**, which has existed since Task 13, carries
`@RateLimit('generalSession')` (`auth.controller.ts:830`), and appears in no row of that table.

So "now seventeen" is only correct if the pre-existing gap is preserved. The honest figure is
**eighteen**.

### The four items the report got right

| Report item | Verdict |
|---|---|
| 1. `frontend.md` §2's rendering table row — "App shell, navigation \| Server component \| Permissions resolved server-side" | **Right.** ADR-0025 falsifies it and the ADR's Consequences say so |
| 2. `frontend.md`'s status banner — "§5 (permissions) and §7 … remain Not Implemented", "§3 is still unexercised" | **Right**, and correctly scoped: §7 is still not implemented and that clause stays true |
| 3. `api/authentication.md` §2 and §7 | **Right in kind**, wrong in the number — see C-7d |
| 6. `ui-ux/page-map.md` | **Right.** Its banner says "Every route listed is Not Implemented as of 2026-08-21" and "Two URLs now answer, and neither counts as a shipped route"; `/settings/security` (`:140`) and `/settings/members` (`:142`) are listed routes that now answer |

### Checked and found NOT falsified

`security/authentication.md` §3's bullet — "so the user can see and revoke their sessions from
`/settings/security`" (`:163`) — was written as design and this task makes it **true**, which is
not a defect. Its banner is stale in several places ("Nothing calls any of §3 yet", "no cookie has
ever reached a browser") but was already stale at `5dbab4e`; Task 17 adds nothing to it.
`security/authorization.md:54` describes the `@AuthenticatedOnly()` class ("read their own session
document, sign out, and manage their factors") in a way the three new routes fit rather than
contradict. `architecture/backend.md:95` and `:195`, `api/errors.md`, `api/pagination.md` and
`api/conventions.md` carry no count this task moves.

---

# The §2 verdict — `CLAUDE.md` rule 10, and whether this deviation is acceptable

The brief asked for this plainly and it has not been written until now. Reviewer 1 established the
facts (the precedent is real; "stricter than logout" is true). This is the judgement.

## THE VERDICT: ACCEPT THE DEVIATION. One sentence of its justification is overstated and should be corrected; the decision itself is right.

A rule with a documented, reasoned exception is healthier than one silently broken, and this one is
documented in three places that a maintainer will actually hit — the service docblock, the
controller docblock, and the report. I would not block on it. What follows is the reasoning,
including the part of the implementer's argument that does not survive checking.

## 1. Is the precedent real, and does the reasoning transfer?

Yes to both, and I re-read it rather than inheriting reviewer 1's check.

`logout.service.ts:55-73` is not merely similar — it is the same argument, in the same words, about
the same two stores, reaching the same ordering:

> "`SessionService.revoke` takes no transaction handle — deliberately, since it owns an ordering
> that spans Redis and Postgres — so one transaction covering both is not expressible without
> reopening Task 6. The order chosen is **revoke, then audit** … Auditing first would mean a
> failure in the revocation leaves an append-only row asserting a logout that did not happen. This
> codebase treats a false statement in an append-only table as the worse outcome … so the gap is
> preferred to the lie."

`session-management.service.ts` does the same thing to the same stores through the same injected
client. The transfer is exact, not analogical.

**And the direction it chose is the right one.** For an append-only security log that an incident
review depends on, a *missing* row and a *false* row are not symmetric costs. A missing row makes
the log incomplete: the investigator knows the log is a floor, not a ceiling, and goes looking for
corroboration. A false row makes the log **wrong**: an investigator reading "session `ses_x` was
revoked at 14:02" would stop looking, and if the revocation had in fact failed, the stolen
credential is still live and nobody is hunting it. An append-only table's entire value is that its
contents are true. Preferring the gap to the lie is correct and I would have argued for it.

## 2. The interleaving, constructed

Process dies between the revoke and the audit — a pod eviction, an OOM kill, a `SIGKILL` during a
deploy — in the window between `session.service.ts:788` returning and
`session-management.service.ts:229`'s `$transaction` committing:

```
t0  DELETE /api/v1/auth/sessions/ses_TARGET arrives, guards pass
t1  SessionService.revokeOwned →  findById(ses_TARGET)                    [Postgres read]
t2                              →  poison([tokenHash])                    [Redis: tombstone, TTL 60s]
t3                              →  repository.revokeById(...)             [Postgres: revokedAt = now]
    ---- the session is now dead, in both stores. The API has not answered. ----
t4  << the process dies here >>
t5  PlatformAuditEvent row: never written
t6  the client sees a dropped connection; the cookie is NOT cleared (the controller never
    reached `if (wasCurrent)` at auth.controller.ts:787)
```

**What survives, and what is lost.** The loss is smaller than "no audit trail", and stating it
precisely is what makes the deviation acceptable rather than merely tolerated:

| | Survives? |
|---|---|
| That the session was revoked | **Yes** — `Session.revokedAt` is set, and it is the column the audit row's `resourceId` was going to point at anyway |
| When it was revoked | **Yes** — same column |
| Which user owned it | **Yes** — `Session.userId` |
| **Who asked, from where** — the `ip`, `userAgent` and `requestId` of the revoking request | **NO** |
| **Whether it was a single revocation or a bulk one**, and how many rows moved (`metadata.scope`, `metadata.revoked`) | **NO** |
| A `SESSION_REVOKED` row to correlate against `LOGIN`/`LOGIN_FAILED` on a timeline | **NO** |

So an incident review retains the *fact* and loses the *actor context*. For the question these
routes exist to answer — "was the attacker's session killed, and when" — the surviving evidence is
sufficient. For "did the legitimate user kill it, or did the attacker kill the legitimate user's
other sessions to lock them out" — which is a real attack shape on a session-management screen —
the lost `ip`/`userAgent` is exactly the evidence you wanted. That is a genuine cost, and it is the
reason this verdict is "accept with a correction owed" rather than "accept, nothing to see".

## 3. The failure that is likelier than process death, and is not in the report

An audit **write error** — not a crash — is the common case, and it produces a worse-shaped state
than the crash does:

`revokeOne` (`session-management.service.ts:172-176`) awaits `this.record(...)` and does not catch.
A `$transaction` failure therefore propagates through the service, past `revokeSession`, and the
controller **never reaches its cookie clear** at `auth.controller.ts:786-789`. The caller gets a
500, their current session is genuinely revoked on the server, and their browser is left holding
`__Host-session` and `__Host-csrf` for a dead session — which is the "signed-in-looking app that
401s on everything" the review brief named in §1, arrived at from a third direction.

**This is not a Task 17 regression.** `logout` has the identical shape: `auth.controller.ts:504`
awaits `this.logouts.logout(...)` and clears cookies at `:514`, after it. The behaviour is
inherited, it is consistent, and the report's "Neither error is swallowed: … a logout that could
not be audited is a 500 rather than a quiet 204" is true of both. Recorded here because the brief
asked what the interleaving costs, and this is the branch of it that a real deployment will hit
first.

## 4. Could it have been in a transaction? Concretely: the Postgres half, yes.

The report says one transaction over both "is not expressible without reopening Task 6". **That is
true of Redis and not true of Postgres, and the sentence does not distinguish them.**

Measured:

- `SessionRepository`'s constructor is `@Inject(PRISMA) private readonly store: SessionStore`
  (`session.repository.ts:154`). `SessionManagementService`'s is
  `@Inject(PRISMA) private readonly store: IdentityStore`
  (`session-management.service.ts` constructor). `PRISMA` is one token —
  `export const PRISMA = 'SENTINEL_PRISMA'` (`apps/api/src/infrastructure/tokens.ts:11`). **Both
  narrow the same PrismaClient instance through two different structural port types.** There is no
  second connection, no second database, and nothing physical preventing one transaction from
  covering `session.updateMany` and the `PlatformAuditEvent` insert.
- `SessionStore` already declares `$transaction` (`session.repository.ts:133`) and
  `SessionRepository` already uses it — `rotate` at `:372-380` runs an `updateMany` and a `create`
  inside one. So the pattern exists in this very file.
- What blocks it today is a signature: `revokeById(id, revokedAt)` (`:195`) takes no `tx` handle
  and calls `this.store.session.updateMany` directly.

The shape that would satisfy rule 10 for the part that can satisfy it:

```
poison([tokenHash])                       // Redis, outside — it cannot be in a PG transaction
await store.$transaction(async (tx) => {
  const moved = await repository.revokeById(tx, id, now);   // ← the one changed signature
  if (moved) await audit.record(tx, { action: 'SESSION_REVOKED', ... });
});
```

The conditional audit — the "stricter than logout" property, which reviewer 1 verified is real —
survives that rewrite unchanged, because `updateMany`'s count is available inside the transaction.

**The residual, and why it does not defeat the argument.** The Redis tombstone stays outside, so a
rolled-back transaction would leave a tombstone over a session that was not revoked. Measured
consequence: `SessionService.resolve` returns `{ outcome: 'revoked' }` on a tombstone
(`session.service.ts:517`) and the tombstone is written with `cacheTtlSeconds`, default **60**
(`session.service.ts:932-935`). So the session would be refused for up to a minute and then work
again — a bounded, self-healing, fail-*safe* denial. That is a strictly better residual than the
present one, which is a permanently missing audit row.

**So: yes, it could have been done, and it would have been better.** It is one parameter on one
repository method. The implementer's reasoning is sound in every part except the claim that the
constraint is absolute; the constraint is real for Redis and is a port signature for Postgres.

## 5. Why this is still an ACCEPT

Four reasons, in order of weight:

1. **It matches the shipped precedent in the same module.** A codebase where `POST /auth/logout`
   and `DELETE /auth/sessions/:id` audit differently is worse than one where both carry the same
   documented compromise. Fixing this one alone would create the inconsistency; fixing both is a
   change to Task 6-era code that this task's brief did not authorise.
2. **The direction is right.** Gap over lie, for an append-only log. See §1.
3. **The loss is bounded and partially recoverable.** `Session.revokedAt` is not lost. See §2's
   table.
4. **It is declared, not hidden.** Rule 10 is named, the departure is named, the reasoning is
   written where the next maintainer stands, and the report lists it under "What is NOT done, and
   is not claimed". That is the behaviour a rule-with-exceptions regime is supposed to produce.

**What is owed, and it is small:** the sentence "one transaction over both is not expressible
without reopening Task 6" appears in two docblocks (`logout.service.ts:58-61` and
`session-management.service.ts`'s equivalent) and is more absolute than the code supports. The
accurate sentence is "the Redis half cannot be in a Postgres transaction; the Postgres half could
be, and is not, because `revokeById` takes no transaction handle." That is a correction to a
justification, not a defect in behaviour, and it belongs to whoever next touches Task 6's
revocation path. **Recorded, not fixed — this reviewer fixes nothing.**

---

# Checked and found FINE — reviewer 2

A review reporting only problems gives no signal about coverage. Everything below was opened,
run, or counted, and is **not** a finding.

## The 401 → login redirect (brief §4)

| Check | Result |
|---|---|
| `git diff 5dbab4e..HEAD -- apps/web/src/api/redirect.ts` | **0 bytes.** `safeRedirectPath` is untouched, including the output re-check Task 16's review added |
| Is there a second helper? | **No.** `AppShell.tsx:97` is `router.replace(loginHrefForDestination(pathname))` and `:88` is `isSessionExpiry(query.error)` — Task 16's two functions, imported from `../api/redirect` at `:9` |
| Can the shell route around `safeRedirectPath`? | **No.** `grep -rn "router\.(replace\|push)\|window\.location\|redirect(" apps/web/src apps/web/app` (non-spec) returns six lines: the one above; `AppShell.tsx:167`'s `router.replace('/login')` on sign-out, a **string literal** with no input in it; and four pre-existing lines in `src/auth/` from Task 16. **No `window.location` assignment anywhere in `apps/web`** |
| Does the redirect run during render? | No — `useEffect` at `:94-98`, with the reason written on it. `if (query.isPending \|\| expired) return <ShellSkeleton />` at `:100` means the shell chrome is never painted for an expired session |
| Is the destination validated on the way in? | Yes, by `loginHrefForDestination` itself (`redirect.ts:110`, `safeRedirectPath(destination, '')`) |

One observation, not a finding and not measured here: `usePathname()` yields the path without the
query string, so a destination like `/settings/members?invite=1` returns as `/settings/members`.
That loses a little context on return; it cannot loosen `safeRedirectPath`, because a value the
validator never sees cannot get past it.

## The `qrcode` dependency (brief §4)

| Check | Measurement |
|---|---|
| Encoding only, no library output into an HTML parser | `grep -rn "qrcode" apps/web/src apps/web/app` returns **one import**: `import { create as createQrCode } from 'qrcode'` (`QrCode.tsx:3`). No `toString`, no `toDataURL`, no `toCanvas`. `grep -rn "dangerouslySetInnerHTML\|innerHTML" apps/web/src apps/web/app packages/ui/src` returns **two lines, neither of them markup**: the `QrCode.tsx:25` docblock explaining why it is not used, and a `Button.spec.tsx` assertion about hex colours. The modules are rendered as React `<rect>` elements (`QrCode.tsx:74-83`) |
| ADR-0013's 1440-minute floor | **Satisfied, not bypassed.** `git diff 5dbab4e..HEAD -- pnpm-workspace.yaml` → **0 bytes**; `pnpm-workspace.yaml:32` is `minimumReleaseAge: 1440` and `:34` reads "minimumReleaseAgeExclude is deliberately absent" |
| Did the `--ignore-scripts` install leave the lockfile honest? | **Yes.** Backed up `pnpm-lock.yaml`, ran `pnpm install --lockfile-only --ignore-scripts`, and `git diff --stat -- pnpm-lock.yaml` was **empty** — the committed lockfile is exactly what a clean resolve produces. `pnpm install --frozen-lockfile --lockfile-only` exits **0** |
| Known vulnerabilities introduced | **None.** `pnpm audit --json` reports 16 advisories, and every one resolves through `testcontainers`, `@prisma/config` or `@nestjs/platform-express`. **No advisory path contains `qrcode` or any of its dependencies** |

**One thing worth the orchestrator's attention, reported rather than filed as a finding.**
`qrcode@1.5.4` brings **17 transitive packages**, and most of them are its CLI's, not its
encoder's: `yargs@15.4.1`, `yargs-parser@18.1.3`, `cliui@6.0.0`, `wrap-ansi@6.2.0`, `y18n@4.0.3`,
`which-module`, `set-blocking`, `require-main-filename`, `camelcase@5.3.1`, `decamelize@1.2.0`,
`find-up@4.1.0`, `locate-path@5.0.0`, `p-limit@2.3.0`, `p-locate@4.1.0`, `p-try@2.2.0`, plus
`pngjs@5.0.0` and `dijkstrajs@1.0.3` (18 new lockfile entries counting `qrcode` itself). That is
supply-chain surface the docblock's justification does not mention.

**None of it reaches the browser**, which is the part that matters and which nobody had measured.
Against the build output already in the tree:

```
$ cd apps/web/.next/static && for t in yargs pngjs dijkstrajs y18n camelcase; do
    echo "$t -> $(grep -rl "$t" . | wc -l) file(s)"; done
yargs -> 0 file(s)     pngjs -> 0 file(s)      dijkstrajs -> 0 file(s)
y18n  -> 0 file(s)     camelcase -> 0 file(s)
```

and the encoder itself did ship — `chunks/146xtzbi7grur.js`, 40,777 bytes, is the chunk carrying
it. So the cost is a ~40 KB client chunk and 17 packages in the dependency graph, not 17 packages
in the bundle. Report item 7 ("nothing measured its cost") is now measured.

## Recovery codes (brief §4)

`RecoveryCodes.tsx:15-16` exports the sentence as a constant rather than burying it in JSX:

> `These codes will not be shown again. Save them now — each one signs you in once if you lose your
> authenticator.`

It is rendered in a `warning` `<Alert>` above the codes (`:41-43`), and the report's mutation 10
(removing it) killed **three** tests across two files. That is a plain statement, in the required
words, in the required place. Nothing sends a code anywhere: no `fetch`, no logging, no analytics
in that file.

One wart, not a finding: the download handler calls `URL.revokeObjectURL(url)` on the line after
`anchor.click()` (`:88-92`). Revoking a blob URL synchronously after a programmatic click is a
known-flaky pattern in some browsers. It is a functional risk on a convenience button, not a
security one, and the codes are on screen and copyable regardless.

## `/dashboard` (brief §4)

No mock product UI. The page renders one heading ("There is no product here yet."), one warning
alert naming Phase 2, and two paragraphs of links to `/settings/security` and `/settings/members`.
**No metric tile, no chart, no seeded table, no number of any kind.** The docblock at
`dashboard/page.tsx:22-24` states the rule and `e2e/app-shell.spec.ts:133` ("the dashboard still
refuses to invent a product") is the test. The copy change is scoped to what became true —
the Phase 2 identity sentence — and the "no asset, no scope, no scan and no finding" sentence, which
is still true, stays.

Its one inaccuracy is folded into **C-5**: "Invite people, change their roles and remove them on
Members" is told to every user, including those the API will refuse.

## The organisation-switch cache clear, the parts that DO work

Both shipped `OrganizationSwitcher.spec.tsx` assertions reproduce and the store really is emptied
— including keys that never named an organisation, which is the case a selective invalidation
would miss. Next's router cache holds no tenant data to clear (every `(app)` page fetches
client-side per ADR-0025; all four files read). An in-flight request that resolves after the
switch does not repopulate anything — reviewer probe P3 ended with the cache empty and neither
tenant's row on screen. The failure is only in the repaint, and it is **C-4**.

## Housekeeping

The three reviewer probe files (`apps/web/src/app/reviewer-cache.spec.tsx`,
`apps/web/src/app/reviewer-observer.spec.tsx`, `apps/web/src/settings/reviewer-members.spec.tsx`)
were deleted before this commit. `git status --short` is empty apart from this file, and
`pnpm check:specs` exits **0** reporting **144 spec files** — the same number the citation pass
recorded, so nothing of the reviewer's is left behind.

---

# Summary — reviewer 2's findings

| # | Severity | What |
|---|---|---|
| C-4 | **High** | `queryClient.clear()` empties the cache without repainting; after an organisation switch the shell renders the previous organisation's name, permission set and page data until the user navigates or reloads |
| C-7 | **Medium** | The report's "documentation this makes false" list misses `security/abuse-prevention.md` entirely, wrongly says nothing is owed on `security/audit.md`, and gets two counts wrong (11→14 `@AuthenticatedOnly()` routes, not 1→4; §7's table should read eighteen, not seventeen) |
| C-5 | **Low** | `/settings/members` tells a member without `organization.manage_members` they "can see who belongs to this organisation" — both list routes 403 — and reports the 403 as "Try reloading the page" |
| C-6 | — | `usePermission` / `<Can>`: **fine**, docstring in the required words, no code path treats either as a control, all four gated affordances refused server-side |
| §2 | — | **Rule-10 deviation: ACCEPTED.** One sentence of its justification is overstated — the Postgres half of the transaction was expressible |

## Not reached by either reviewer

- **`MfaPanel`, `PasswordPanel` and `SecurityScreen` were not read line by line.** Reviewer 2 read
  `RecoveryCodes.tsx` and `QrCode.tsx` in full because the brief named them, and read
  `MembersScreen.tsx`, `AppShell.tsx`, `OrganizationSwitcher.tsx` and `session-context.tsx` in full.
  The three MFA/password panels were checked only for what the brief asked about them.
- **No mutation testing of reviewer 2's own** beyond the three probes described. The report's
  eleven mutations were not re-run; reviewer 1 re-ran the decisive one (7/7b).
- **Nothing was seen in a browser**, which the report already states as outstanding. C-4 in
  particular would be obvious in thirty seconds of clicking, and no automated test in this
  repository is positioned to catch it.
