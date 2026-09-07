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
