# Task 17 — adversarial review

> **A dated record of what was found at review time. Not a description of current state —
> [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

Fresh adversarial reviewer, 2026-09-07. Branch `feat/phase-2-task-17-app-shell`, range
`5dbab4e..HEAD` (commits `6118952..7463389`). The reviewer did not write this code.

Written incrementally from the first minutes and committed as it went (ruling 131).

## Status: IN PROGRESS

## Pass 1 — citation (in progress)

## Pass 2 — code (not started)

## Findings (in progress)

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
