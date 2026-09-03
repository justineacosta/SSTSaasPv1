# Task 15 — dispositions on the adversarial review, and the accept endpoint

> **A dated record of what was said and decided at the time. Not a description of current state —
> [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

Written by the orchestrator on 2026-09-04. Review:
[`review.md`](review.md). Every finding is dispositioned below with its cost if the ruling is
wrong.

## Split of ownership for this round

The orchestrator owns every `.claude/` document, both ADRs, this ledger, and the
`emails/registry.ts` census. **You own everything under `apps/api/` and the migration-adjacent
code.** Do not edit `.claude/` — list what you believe is false and hand it up, as before.

## Dispositions

| # | Finding | Severity | Disposition |
|---|---|---|---|
| F-1 | `revoke`'s docblock and the report claim an expired invitation answers 404; it answers 204 | High | **FIX — the code is right, the prose is wrong.** Yours: the docblock and the test. |
| F-2 | The tenant limiter pass is skipped by every refusal above it, so a caller who fails a guard has no limit on the create route | Medium | **ACCEPT, and record it.** Orchestrator's: ADR-0023's Consequences. |
| F-3 | `accept`, when built, cannot carry a `perOrganization` class, and nothing records that | Low | **FIX — yours**, as a comment where the route is declared. |
| F-4 | Token discipline clean | — | No action. |
| F-5 | Audit events in-transaction, correct type, absence honest | — | No action. |
| F-6 | Tenant-client test: a real guard traded for a weaker one plus a sentinel, loss stated | Low | **ACCEPT.** The honesty is what was asked for. |
| F-7 | Cross-tenant tests exist but cannot fail for the application layer alone | Low | **ACCEPT, unchanged.** RLS is the backstop and it is doing its job; the review says so. |
| F-8 | D4 and D5 hold; lock key matches `TokenService` | — | No action. |
| F-9 | The report's mutation row claims a red run that does not happen; ruling 99's predicate is not guarded term-by-term | Medium | **FIX — yours, and the fix is a comment plus a test, not a code change.** See below. |
| F-10 | Nine `.claude/` sentences still false at HEAD | Medium | **FIX — orchestrator's.** |
| C-1 | `registry.ts` says NINE members; there are ten | Low | **FIX — orchestrator's.** |
| C-2 | `authorization-matrix.integration.spec.ts:45` says "Seven routes … counted from the constant below"; the constant holds ten. Line 57's "other five" is now eight | Medium | **FIX — yours.** Ruling 108 inside a file this task edited. |
| C-3 | Report §5's `@@unique` census does not reproduce | Low | Noted here; the report is a dated record and is not rewritten. The correct census is: three declarations, seven comment hits. Its conclusion was right. |
| C-4 | ADR-0022 cites the RLS policy at `migration.sql:18-20`; the predicate is at line 21 | Low | **FIX — orchestrator's.** |
| Area 2 | ADR-0022 overstates containment: "an opaque organisation id they cannot act on" | Medium | **FIX — orchestrator's.** The reviewer is right and the sentence is mine. |

### F-1 in detail — the ruling, and why

**The 204 is correct and the prose is wrong.** The argument that settles it is not in either
document: **`list` applies no liveness filter.** `invitation.service.ts`'s `list` selects on
`organizationId` and the cursor alone, so an expired invitation is returned by
`GET /organizations/:id/invitations`. A caller who can see a row in the list and is told 404 when
they ask to revoke it has been given two contradictory answers about the same row.

Revoking an expired invitation is also a real write with a real effect: it sets `revokedAt`, which
takes the row out of the partial unique index's live set and frees the `(organizationId, email)`
slot immediately rather than waiting for a supersede. "There is nothing to revoke" is false.

**Cost if this ruling is wrong:** a caller learns that an expired invitation existed, by getting
204 where they might have got 404. That is not a disclosure — they hold `organization.manage_members`
in that organisation and the row is already in the list they can read.

Do three things: delete the sentence from the `revoke` docblock and replace it with what the code
does and why; add the expiry case to the revoke test at
`invitations.integration.spec.ts:850` or as its own `it`; and state in your report that the report's
§4 item 7 was wrong, without editing the report itself.

### F-9 in detail — the mutation row is false, and the guard cannot exist term-by-term

The reviewer measured that removing `deletedAt: null` from `assertNotAlreadyAMember` leaves
**20/20 green on two runs**, and that removing `status: 'ACTIVE'` alone is green too. Only removing
**both** goes red.

**That is not a missing test. It is the database working.** The CHECK constraint
`Membership_status_deletedAt_agree_check` makes `("deletedAt" IS NULL) = (status <> 'REMOVED')` a
biconditional, so the two terms are equivalent by construction and no test can distinguish them.
A mutation that deletes one term cannot go red, and one that claims it did is reporting something
that did not happen.

Your fix is **a comment and a test, not a code change**. Keep both predicates. Write beside them
that the pair is guarded and neither term alone can be, naming the CHECK constraint as the reason,
so the next reader does not "simplify" one away believing a test will catch it. Then make sure a
test exists that removes both and goes red, and say in your report which test that is and what you
measured when you mutated it.

**Cost if this ruling is wrong:** if the CHECK were ever dropped, the two terms stop being
equivalent and the untested one becomes live. The comment must name that dependency explicitly.

## The main work: `POST /api/v1/invitations/accept`

The blocker you reported is real — the orchestrator reproduced it independently — and it is now
cleared. **Migration `20260904020000_invitation_lookup_function` is written, operator-approved,
applied, and verified.** You do not write a migration. `ADR-0022` records the decision.

`public.invitation_organization_by_token_hash(text) RETURNS text` is `SECURITY DEFINER`, owned by
`sentinel_org_lookup`, `search_path = public, pg_temp`, `EXECUTE` granted to `sentinel_app` and
revoked from `PUBLIC`. Proven end to end in a rolled-back transaction as `sentinel_app`:

```
A. direct read, no org set        0
B. definer function, no org set   org_probe_t15
C. definer function, wrong hash   NULL
D. direct read, correct org set   1
```

**The function returns one column and makes no policy decision.** It does not filter on
`acceptedAt`, `revokedAt` or `expiresAt`, and does not look at the invited address. Every one of
those decisions is yours, in the handler, under RLS, inside a tenant transaction scoped to the id
the function returned.

### The shape

1. Hash the presented token the way `create` hashes it, and call the definer function with the
   hash. A `null` return is "no such invitation" — answer exactly as D11 requires.
2. Open `withTenantTransaction` on the returned id. **Everything below is under RLS.**
3. Take the organisation lock, the way `membership.service.ts` does. `lockOrganization` is not
   exported today; export it rather than writing a second one.
4. Re-read the invitation by `tokenHash` inside the transaction, and decide liveness, expiry, and
   the address binding **there**. Do not trust anything the definer function implied.
5. Consume conditionally — an `updateMany` matching only a live, unexpired row, asserting it
   affected exactly one — and create the `Membership` in the same transaction. Two concurrent
   accepts of one token must produce exactly one membership.
6. Write `INVITATION_ACCEPTED` in the same transaction as the change (CLAUDE.md rule 10).

### The security properties, each of which needs a test

- **D11 — the invited address is compared to the authenticated user's, never to a body field.**
  A different signed-in user presenting a valid token gets the same answer as one presenting a
  token that matches nothing. **The plan calls this "the interesting attack, not the happy path".**
- **D2 — no `@RequireVerifiedEmail()` on this route.** Possession of a token delivered to that
  address is the proof that guard exists to obtain. Write the reason where the route is declared.
- **The re-invite-a-removed-member journey, end to end**, which is the case Task 1's partial index
  and this task's partial index exist for and which the plan assigns to Task 15: invite, accept,
  remove via Task 14's `DELETE .../members/:membershipId`, invite again, accept again. Both
  memberships exist as rows; exactly one is live.
- **Two concurrent accepts of one token yield exactly one `Membership`** — deterministic, not a
  `Promise.all`. Ruling 119 and your own M1 result: use the session-level advisory-lock blocker
  that worked, not the arm that was green on 2 of 3 runs.
- A revoked invitation cannot be accepted. An expired invitation cannot be accepted.
- An accepted invitation cannot be accepted twice.
- Cross-tenant: mandatory, per CLAUDE.md.

### D9 / ruling 122 — you must answer this now, and it is the reason accept is interesting

"Wherever a credential is issued against a fact that can change, the fact must be re-read **after**
the issue and the credential revoked if it moved."

Accepting issues a `Membership` — a credential — against the invitation's liveness and the
organisation's state. Work out whether the transaction plus the conditional consume closes the
window, or whether something outside the transaction can still leave a membership standing that
should not: a concurrent revoke, a concurrent organisation suspension, a concurrent removal of the
inviter. **Report the reasoning with a measurement either way.** "The endpoint checks first" is the
argument rulings 82 and 122 both struck down and it is not available to you.

## Verify and report

Every command with its exit code captured outside a pipe. `pnpm test:integration` **twice**, both
exit codes reported — ruling 119, and your own M5 measured a `Promise.all` arm at 1-of-3 flaky.
`pnpm check:openapi` will need `apps/api/openapi.json` regenerated; report the path count before
and after. It read **26** at `fa8ffaf`.

Append to `report.md` under a clear `## Fix round` heading — do not rewrite what is above it; the
ledger is a dated record. Commands, exit codes, measurements. No status prose.
