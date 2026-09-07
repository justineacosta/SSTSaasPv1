# Task 17 — fix round

> **A dated record of what was changed and measured at the time. Not a description of current
> state — [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

Fix-round implementer, 2026-09-07, branch `feat/phase-2-task-17-app-shell`.
Written from the first minutes and committed incrementally (ruling 131).

## Scope taken from `fix-brief.md`

| # | Severity | What the brief requires |
|---|---|---|
| C-4 | High | Make the organisation switch repaint. Test mounts the REAL `AppShell` + `OrganizationSwitcher`. |
| C-1 | Citation + Medium | Correct the docblock AND make `sessionSummarySchema` a runtime enforcer on the API side. |
| C-2 | Medium | Revoking the CURRENT session must sign the user out in the browser. |
| C-5 | Low | A 403 on `/settings/members` renders a Permission state, not an error state. |
| rule 10 | prose | Correct the "not expressible without reopening Task 6" sentence. |
| C-3 | prose | Correct the overstated "no oracle" timing sentence. |

Not touched, per the brief: `.claude/`, `roadmap.md`, `report.md`, `review.md`,
`apps/web/src/api/redirect.ts`, `security-headers.ts`. No migration, no global response
interceptor, no change to audit transactionality.

## Progress

- [ ] C-4
- [ ] C-1
- [ ] C-2
- [ ] C-5
- [ ] rule-10 sentence
- [ ] C-3 sentence
- [ ] verification table

---

## C-4 (High) — the organisation switch now repaints

### The test came first, and it was red before the fix

Three tests added to `apps/web/src/app/AppShell.spec.tsx` in a new block,
`AppShell — switching organisation REPAINTS the shell (review C-4)`. They mount the **real**
`AppShell` — whose session comes from `useSessionQuery`'s live observer, not a literal prop — with
the **real** `OrganizationSwitcher` inside it, against a stateful stub that answers every route for
whichever organisation the session currently names (which is what the real API does: the
organisation is on the cookie, not in the URL). The switch goes through the real `<select>` with
`userEvent.selectOptions`. The assertions are against what is **on screen**.

`pnpm vitest run --project ui apps/web/src/app/AppShell.spec.tsx`, before any change to
`OrganizationSwitcher.tsx`:

```
Test Files  1 failed (1)
     Tests  3 failed | 8 passed (11)
EXIT=1
```

with, printed inside the rendered DOM at the moment of failure:

```
<p data-testid="probe-org">Acme</p>
<p data-testid="probe-permissions">organization.read</p>
```

after the switch to Globex had already succeeded. That is the finding: the cache holds Globex, the
screen holds Acme.

### The fix

`apps/web/src/app/OrganizationSwitcher.tsx` — `onSuccess` was:

```
queryClient.clear();
queryClient.setQueryData(SESSION_QUERY_KEY, next);
```

and is now:

```
queryClient.setQueryData(SESSION_QUERY_KEY, next);
void queryClient.resetQueries({
  predicate: (query) => query.queryHash !== SESSION_QUERY_HASH,
});
queryClient.getMutationCache().clear();
```

**Why `resetQueries`, read out of the installed library rather than assumed** —
`@tanstack/query-core@5.101.4`:

| Primitive | What it does to the store | What it does to a mounted observer |
|---|---|---|
| `clear()` → `QueryCache.clear()` → `remove(query)` → `query.destroy()` = `super.destroy()` + `cancel({ silent: true })` | empties it | **nothing** — `destroy()` never touches `query.observers`, and `silent: true` suppresses the dispatch |
| `resetQueries()` → `query.reset()` = `destroy(); setState(this.resetState)` (`query.js:90-96`) | resets state to `#initialState`, which carries no data | **`setState` dispatches** — every observer is notified, active queries refetch |

**Why the session key is excluded rather than reset.** Resetting it would put `useSessionQuery`
back into `isPending`, which makes `AppShell` swap the shell for its skeleton and unmount the page
mid-switch, and would cost a redundant `GET /auth/session` for a document the switch response
already returned. It is *overwritten* with the new document instead, so nothing from the previous
organisation survives that key either. `hashKey(SESSION_QUERY_KEY)` is compared rather than
`queryKey[0]`, so a future `['session', …]` key is not spared by accident. The mutation store is
cleared separately because `clear()` used to do that.

### Two mutations, both recorded

| Mutation | `OrganizationSwitcher.spec.tsx` (shipped) | `AppShell.spec.tsx` C-4 block (new) | Exit |
|---|---|---|---|
| **M1** — restore the bare `queryClient.clear(); setQueryData(...)` | **8 passed** — fully green with the bug present | **3 failed** | 1 |
| **M2** — `resetQueries` → `removeQueries` (empties, does not notify) | 8 passed | **1 failed** — "does not leave the PREVIOUS organisation's page data on screen" | 1 |
| none (the fix) | 8 passed | 3 passed | 0 |

M1 is the whole argument for why the test was the deliverable: **the shipped suite is green while
the shell renders the wrong tenant.** M2 shows which of the three tests is load-bearing for the
"emptied but never told" class specifically — the two session-shaped tests recover under
`removeQueries` because `setQueryData` still notifies the session query's live observer, and the
page-data test does not, because nothing tells `['findings']`.

### Also changed

`OrganizationSwitcher.spec.tsx`'s "seeds the NEW session document after the clear, not before it"
is renamed to "leaves the NEW session document in place, not swept away by its own switch" — the
ordering is now the other way round and the old name would have been a false sentence in a test
name. The assertion it makes is unchanged.

---

## C-1 — the docblock corrected, and the schema made an actual enforcer

### The prose that was false

`packages/contracts/src/auth.ts`, `sessionSummarySchema`'s docblock, said:

> "Here the shape is closed, so the hash is not merely omitted — it is unrepresentable on the
> wire, and `check:openapi` pins that."

Both halves are false and the correction says so explicitly rather than quietly deleting the
sentence — the false version is the kind a maintainer acts on. The replacement states: a schema is
a value and enforces nothing until something parses through it; at the time that sentence was
written nothing in `apps/api` parsed any response against a contract schema; and `check:openapi`
compares a committed document against a generated one, so it cannot observe a response body.

### The enforcer

New export in `packages/contracts/src/auth.ts` (and `index.ts`):

```
export const sessionCollectionResponseSchema = collectionEnvelopeSchema(
  sessionSummarySchema.strict(),
).strict();
```

and `AuthController.listSessions` now returns `sessionCollectionResponseSchema.parse({ … })`
instead of an object literal.

**`.strict()`, and it is asymmetric on purpose.**

| Side | Schema | Unknown key means | Behaviour |
|---|---|---|---|
| Outbound, `apps/api` | `sessionCollectionResponseSchema` (**strict**) | a handler widened a projection — the unknown key is a hashed credential | **refuse**; the `ZodError` becomes a generic 500 `INTERNAL_ERROR` through `AllExceptionsFilter`, disclosing nothing |
| Inbound, `apps/web` | `sessionCollectionSchema` (non-strict, unchanged) | the API is newer than the open tab | strip — a strict client would break every page for the length of a rolling deploy on an additive API change |

The strict schema is deliberately **not** registered in the OpenAPI document: `ApiDoc` still names
`sessionCollectionSchema`, the two describe the same wire shape, and the document should carry the
one a client is written against. `pnpm check:openapi` is therefore unmoved — exit **0**,
`"routes":29`, byte-identical — which is also the honest statement of what that check covers.

### The reviewer's spread mutation, re-run

Applied verbatim: `session.service.ts` `listOwnedPage` → `sessions: page.map((row) => ({ ...row }))`,
`auth.controller.ts` `listSessions` → `data: page.sessions.map((session) => ({ ...session, createdAt: …, lastSeenAt: … }))`.

| Command | Reviewer, before this fix | Now |
|---|---|---|
| `pnpm --filter @sentinel/api exec tsc --noEmit` | **0** — no error | **0** — no error (unchanged; TypeScript still does not excess-property-check a spread) |
| `pnpm vitest run --project integration apps/api/src/modules/auth/auth.sessions.integration.spec.ts` | 1 — **1 failed / 22 passed**, one assertion: `expected '{"data":[{"id":"ses_…' not to contain 'tokenHash'` | 1 — **16 failed / 7 passed**, every one `expected 200 "OK", got 500 "Internal Server Error"` |

The difference is the finding closed. Before, the endpoint **answered 200 with the hashed
credential in the body** and exactly one assertion noticed. Now the endpoint **cannot answer at
all** — the schema refuses the shape before it is serialised, so there is no response body to
inspect and every test that lists sessions fails. The compiler is still silent; the runtime is not.

Restored from backups afterwards; the same spec is **exit 0, 23 passed**.

### Contract tests added

Four in `packages/contracts/src/auth.spec.ts` under
`sessionCollectionResponseSchema — the closed shape the API answers through`, including the one
that pins the asymmetry: the strict schema **refuses** a row carrying `tokenHash` (and the issue
names the key), while `sessionCollectionSchema` strips it. They were **red before the schema
existed** — `Tests 4 failed | 46 passed (50)`, exit 1 — and are green now: `50 passed`, exit 0.

---

## C-2 — revoking the current session signs the browser out

### The tests came first

Two added to `apps/web/src/settings/SessionsPanel.spec.tsx`, plus a `next/navigation` router mock
the file did not have:

- **`SIGNS THE USER OUT IN THE BROWSER when the revoked row is the CURRENT session`** — clicks
  "Sign out this device", asserts `router.replace('/login')` and that a key seeded before the click
  is gone from the cache. The existing `:123` test asserts the button's *label*; this asserts the
  outcome.
- **`does NOT sign the browser out when the revoked row is another device`** — the half that breaks
  if the fix keys on "a revocation succeeded" rather than on "the revoked row was this session".

### The fix

New file `apps/web/src/app/sign-out.ts` exporting `signOutLocally(queryClient, router)` —
`queryClient.clear()` then `router.replace('/login')`, the two things `AppShell` already did.
**`AppShell.tsx` now calls it too**, so the two sign-out paths are shared rather than copied; two
copies of a sign-out that drift apart is how one of them ends up leaving a cache behind.

`SessionsPanel`'s `revokeOne.onSuccess` now takes the mutation's `sessionId` variable, looks the
row up in the page it already has, and calls `signOutLocally` when that row is `current`;
otherwise it invalidates the list as before. The revoke response is `{ status: 'SESSION_REVOKED' }`
for both cases, so the row's own `current` flag is the only available signal — which is also the
flag the button's label is already keyed on.

`signOutLocally`'s docblock records why `clear()` is still right *there* while the organisation
switcher needed `resetQueries()`: `/login` is outside the `(app)` layout, so the whole subscribed
tree unmounts and there is no observer left that needs telling. C-4's failure mode requires the
tree to stay mounted.

### The mutation

| Mutation | Result | Exit |
|---|---|---|
| **M3** — drop the current-session branch, leaving the shipped `invalidateQueries` alone | **1 failed / 12 passed** — the new current-session test, and only it | 1 |
| none | 13 passed | 0 |

`pnpm vitest run --project ui apps/web/src` with the fix in place: **12 files / 106 tests, exit 0**.

---

## C-5 — a 403 on `/settings/members` is a Permission state, not an error state

### The tests came first

Four added to `apps/web/src/settings/MembersScreen.spec.tsx` under
`a 403 is a PERMISSION state, not an error state (review C-5)`, against a stub that answers **403
`PERMISSION_DENIED`** to every call — which is exactly what `memberships.controller.ts:84` and
`invitations.controller.ts:211` do for a member without `organization.manage_members`:

1. both lists name the missing permission and who can grant it;
2. the words "Try reloading the page" and "could not be loaded" are **absent**;
3. "You can see who belongs to this organisation" is **absent**;
4. a failure that is **not** a 403 still renders the error state, and no permission state.

First run: `Tests 3 failed | 10 passed (13)`, exit 1. (The fourth was already green — the error
branch existed; what did not exist was the discrimination.)

### The fix

`apps/web/src/api/errors.ts` — new `isPermissionDenied(error)`: `error instanceof ApiError &&
error.status === 403`. Keyed on the **HTTP status, not the error code**, because `toApiError` falls
back to `INTERNAL_ERROR` for a 403 whose body it cannot parse and that is still a refusal. Its
docblock carries the same "this is not a permission check, it reads a refusal the server already
made" warning `usePermission` does.

`apps/web/src/settings/MembersScreen.tsx`:

- `members.isError` split into a **Permission** branch (`Alert variant="info"`, `data-testid="members-permission-state"`) and the existing **Error** branch. Same for `invitations.isError`.
- The foot-of-card paragraph's `!canManageMembers` sentence lost its false opening clause. It read
  "You can see who belongs to this organisation. Inviting, removing and changing roles need
  organization.manage_members, which an owner or admin can grant." It now reads "Inviting, removing
  and changing roles need organization.manage_members, which an owner or admin can grant." — the
  half that is true of that caller.

`apps/web/app/(app)/dashboard/page.tsx` — the review folded this in: the dashboard told **every**
user "Invite people, change their roles and remove them on Members", including the ones the API
refuses. It now reads "Managing who belongs to this organisation — inviting, removing and changing
roles, for those who hold organization.manage_members — is on Members." No test asserted the old
sentence (`grep` across all `.ts`/`.tsx` outside `node_modules` and `.next`: nothing).

### The mutation

| Mutation | Result | Exit |
|---|---|---|
| **M4** — fold the 403 back into the single undiscriminated `isError` branch | **3 failed / 10 passed** — the three new 403 tests | 1 |
| none | 13 passed | 0 |

`pnpm vitest run --project ui apps/web/src`: **12 files / 110 tests, exit 0**. `pnpm lint`: exit 0.
