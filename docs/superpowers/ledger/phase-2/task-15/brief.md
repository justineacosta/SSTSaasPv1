# Task 15 — Invitations: implementer's brief

> **A dated record of what was said and decided at the time. Not a description of current state —
> [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

Written by the orchestrator on 2026-09-03, on branch `feat/phase-2-task-15-invitations`, cut from
`main` at `77d74e4`. Mode: fresh implementer subagent + separate fresh adversarial reviewer,
chosen by the operator over the plan's "chained 13→15" because sessions do not persist and there
is no warm implementer to chain to.

## The two rules that bind you before any code

1. **You report commands and exit codes. You do not write status prose.** No "this now works", no
   summary paragraphs, no `roadmap.md` edits, no `.claude/` narrative. Raw evidence goes up; the
   orchestrator writes every sentence that asserts anything. This is execution protocol §3 and it
   is review-blocking.
2. **Cite before you claim.** Every factual assertion about this repository carries the command or
   the file-and-line that establishes it. Do not assume another task's change landed — open the
   file. A correction is a claim too: re-run the check after a fix rather than describing the fix
   from memory.

## What is already done, so you do not rebuild it

Measured on this branch before you started. Verify each rather than trusting this list.

- **The contracts exist.** `packages/contracts/src/invitations.ts` was written in Task 2 and holds
  `createInvitationRequestSchema`, `acceptInvitationRequestSchema`, `invitationResponseSchema`,
  `acceptInvitationResponseSchema`, `listInvitationsQuerySchema` and `invitationCollectionSchema`,
  each with a docblock stating why it is shaped the way it is. **Use them. Do not redesign them.**
  If one is genuinely wrong, say so with the measurement and stop — do not quietly change it.
- **The email template exists.** `renderInvitation` in
  `apps/api/src/modules/auth/emails/token-link.templates.ts`, registered as `invitation` in
  `emails/registry.ts` and listed in `TOKEN_LINK_TEMPLATE_IDS`. Task 5 built it. **You are not
  adding a template**, and a report that says you are repeats a false sentence this phase has
  already caught once (roadmap, Task 5 section).
- **The rate-limit class exists.** `invitations: { perOrganization: { limit: 50, windowSeconds:
  86_400 }, failMode: 'closed' }` at `apps/api/src/common/guards/rate-limit.config.ts:318`.
- **The migration is written, operator-approved, and applied.**
  `packages/db/prisma/migrations/20260903160000_invitation_partial_unique/`, and
  `@@unique([organizationId, email])` is already removed from `model Invitation` in
  `schema.prisma` with the comment explaining why. `pnpm db:migrate` exited 0; the index
  `Invitation_organizationId_email_live_key` is present in Postgres, confirmed by `pg_indexes`.
  **You do not write a migration.** If you find you need a second one, stop and report — the
  operator reviews migration SQL before it touches a database (execution protocol §5).
- **`assertActorMayGrant` exists**, exported from
  `apps/api/src/modules/memberships/membership.service.ts:315` with a table-driven spec in
  `membership.service.spec.ts`. It compares permission **sets** from `ROLE_PERMISSIONS`, not role
  rank.

## What you are building

Four endpoints, one module at `apps/api/src/modules/invitations/`, following the shape of
`modules/memberships/` exactly — module, tokens, controller, service, controller spec, service
spec, integration spec. Read those seven files before you write anything; they are the
conventions, and re-inventing them is the failure mode this brief exists to prevent.

| Route | Guards |
|---|---|
| `POST /api/v1/organizations/:id/invitations` | `@RequirePermission('organization.manage_members')`, `@RequireVerifiedEmail()`, rate-limit class `invitations` |
| `GET /api/v1/organizations/:id/invitations` | `@RequirePermission('organization.manage_members')` |
| `DELETE /api/v1/organizations/:id/invitations/:invitationId` | `@RequirePermission('organization.manage_members')` |
| `POST /api/v1/invitations/accept` | authenticated only — see below |

### Decisions already taken. Follow them; challenge them with a measurement or not at all.

**D1 — `POST /invitations/accept` is not under `/organizations/:id`, and carries no permission.**
The acceptor is not a member yet, so the tenant guard has nothing to resolve and any
`@RequirePermission()` would deny by construction. The route is authenticated, tenant-less, and
takes the token in the body. Confirm against Task 12's guard pipeline what an authenticated,
tenant-less route actually needs to declare, and report what you found — do not guess.

**D2 — accept does NOT carry `@RequireVerifiedEmail()`.** `security/authentication.md` §6 says an
unverified user "cannot create organisations, invite, or scan"; it does not say they cannot accept.
Possession of a token delivered to that address is the same proof of address control that the
verification guard exists to obtain, so requiring the guard here would demand the proof twice and
lock out the exact person the invitation was for. `create` does carry it, because inviting is in
that sentence's list.

**D3 — the plan's "routes through registration and is consumed after verification" adds no code to
the registration handler.** A person with no account registers, verifies, signs in, and then posts
the token. That satisfies the sentence without coupling two subsystems. **Do not add invitation
awareness to `registration.service.ts`.** If you believe the sentence demands more, report the
argument rather than building it.

**D4 — re-invitation supersedes.** `create` runs in one transaction: take an advisory lock keyed on
the `(organizationId, email)` pair, set `revokedAt` on any row for that pair that is still live
(`acceptedAt IS NULL AND revokedAt IS NULL`), then insert. This is
`security/authentication.md` §6's "invalidated by use or by a newer token" and it is the shape
`TokenService.issue` already uses for `VerificationToken` — read that method and match it,
including how it derives the advisory-lock key. The superseded row does **not** get its own
`INVITATION_REVOKED` audit event: that name means a person revoked it and a reader would look for
an actor. The new `MEMBER_INVITED` event carries the superseded id in `metadata` instead.

**D5 — the no-minting rule is the third call site and you import it, you do not rewrite it.**
`assertActorMayGrant(ctx, grantedPermissionKeys)`. An `ADMIN` may not invite an `OWNER` for the
same reason they may not promote one. If importing across module boundaries creates a cycle,
extract the function to a shared home and update both importers — **measure the cycle before you
move anything**, and report which you did and why.

**D6 — three audit actions, not four, and the fourth's absence is documented in place.** Add
`MEMBER_INVITED`, `INVITATION_REVOKED` and `INVITATION_ACCEPTED` to `AUDIT_ACTIONS`, and add
`'Invitation'` to `AUDIT_RESOURCE_TYPES`. The plan asks for an expiry event as well; **there is no
producer for one.** Expiry is a passive fact — no actor, no transaction, no sweeper in this
codebase — and `audit.actions.ts`'s own governing rule is "only names something in this codebase
writes". Record the absence with its reason in that file, in the shape the `ORGANIZATION_DELETED`
comment already uses. Note that file's docblock carries a census of both constants that you must
update and that has been wrong before: **compute the counts, do not adjust them** (ruling 108).

**D7 — every `Membership` read excludes the soft-deleted, and says so.** Ruling 99. A removed and
re-added member has several `Membership` rows for one `(organizationId, userId)`; the partial
unique index guarantees one row only under `deletedAt IS NULL`. The "is this address already a
member?" check in `create`, and the "are they already a member?" check in `accept`, are both this
hazard. Ruling 100 binds the test: **arrange it to lose** — remove-then-re-add, so the live row is
physically last and a resolver without the predicate returns the removed one. A test that passes
under the mutation is not a guard.

**D8 — acceptance is one transaction and consumes conditionally.** Take the organisation lock the
way `membership.service.ts` does (`lockOrganization`), consume the invitation with a conditional
write that matches only a live, unexpired row and asserts it affected exactly one, and create the
`Membership` in the same transaction. Two concurrent accepts of one token must produce exactly one
membership; assert that with a real concurrent integration test, not a sequential one.

**D9 — ruling 122 applies here and you must decide whether it bites.** The rule: where a credential
is issued against a fact that can change, re-read the fact after issuing and revoke if it moved.
Accepting issues a `Membership` against the invitation's liveness and the organisation's state.
Work out whether the transaction plus the conditional consume already closes the window, or whether
something outside the transaction (a concurrent revoke, a concurrent organisation suspension) can
still leave a membership standing that should not. **Report the reasoning with a measurement
either way.** "The endpoint checks first" is the argument ruling 82 struck down and ruling 122
struck down again; it is not available to you.

**D10 — `MembershipStatus.INVITED` gets no producer from this task, and that is deliberate.** The
plan says acceptance creates the membership, so no `Membership` row exists while an invitation is
pending. `grep` confirms nothing outside tests writes `'INVITED'` today. Do not start. Document the
deliberate absence where a reader will meet it.

**D11 — the invited address must be compared to the authenticated user's, never to a body field.**
`acceptInvitationRequestSchema` carries the token alone, by design, and its docblock says a
body-supplied address "would be the whole attack". Both addresses go through the shared
`emailSchema` normalisation. A different signed-in user presenting someone else's valid token gets
the same answer as one presenting a token that does not exist — decide which status code from
`.claude/api/conventions.md` and `errors.md` rather than inventing one, and cite the section.

## The thing this change breaks, which you own

`packages/db/src/tenant-client.integration.spec.ts` **does not compile on this branch.** Measured:
`pnpm typecheck` exits 2 with `TS2561: 'organizationId_email' does not exist in type
'InvitationWhereUniqueInput'` at lines 107 and 115. Removing the `@@unique` removed the compound
`where` input Prisma generated for it.

Read that test's comment before touching it. Its property is that the tenant client runs the
original query unmodified rather than rewriting `where`, and it needs a **compound** unique on a
**tenant-owned** model to express that. It was already retargeted once, from
`Membership.@@unique([organizationId, userId])` to Invitation's, when Task 1 made Membership's
uniqueness partial. `TENANT_OWNED_MODELS` is `['Membership', 'Invitation', 'AuditEvent']`
(`packages/db/src/tenant-resources.ts:12`), and after this change **none of the three carries a
compound `@@unique`** — verify that claim yourself against `schema.prisma`.

So the test has no subject left. Propose what to do, with the measurement behind it. **Deleting it
silently is not an option, and neither is adding a constraint to the schema so a test has something
to point at.** State plainly if the honest answer is that the property is no longer expressible
against a real model, and what is lost if it goes.

## Test-first, and at the layer it can fail

`CLAUDE.md`'s testing rules, not a summary of them. The interesting tests, named because a happy
path suite would miss every one:

- A different signed-in user cannot consume someone else's invitation. **The plan calls this "the
  interesting attack, not the happy path".**
- Re-inviting a removed member works end to end: invite, accept, remove via Task 14's endpoint,
  invite again, accept again. This is the case the partial index unblocks and the plan says its
  test lives here.
- An `ADMIN` cannot invite an `OWNER`.
- Two concurrent accepts of one token yield exactly one `Membership`.
- Two concurrent creates for one `(organizationId, email)` do not both survive.
- An expired invitation is refused, and re-inviting that address succeeds (the predicate does not
  cover expiry — the supersede path does, and that is what this proves).
- A revoked invitation cannot be accepted.
- **Cross-tenant isolation is mandatory** (`CLAUDE.md`): Tenant A gets 404 for Tenant B's
  invitation ids, on read and on revoke.
- The list response never carries a token. `invitations.spec.ts` in contracts already pins the
  schema-stripping half; the integration test is the other half.

## Verify, and report exactly this

Run each with the exit code captured outside a pipe — `out=$(pnpm <cmd> 2>&1); code=$?` — because
`$?` after a pipe reports the last stage's status, not the command's.

`pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm check:specs`,
`pnpm test:integration`, `pnpm build`, `pnpm check:openapi`, `pnpm check:registry`,
`pnpm check:secrets`.

**Run `pnpm test:integration` twice, end to end, and report both exit codes.** Ruling 119: Task 14
made that lane red on a coin flip and two runs on one tree gave `EXIT=1` then `EXIT=0`. One green
run is not evidence that a suite with concurrency in it is green.

`pnpm check:openapi` will fail until you regenerate `apps/api/openapi.json`; report the route count
before and after. It read **24 paths** on `main` at `77d74e4`.

## Documentation you own

Per execution protocol §6, in the same change. Do not write status prose in them — list the files
you believe are now false, quote the sentence, and hand it up. The orchestrator writes the
replacement text.

At minimum, check: `.claude/security/authentication.md` §6 (the invitation row is marked "Designed
only" at line 358), `.claude/security/audit.md` §4 (the taxonomy group that still lists the
invitation actions as unwritten), `.claude/product/permissions.md` (lines 112 and 127 both name
Task 15's invitation acceptance as unwritten), `.claude/api/authorization.md` §4 (the no-minting
rule's third enforcement point), and whatever the endpoint list in `.claude/api/` turns out to be.

## Deliverable

A report at `docs/superpowers/ledger/phase-2/task-15/report.md`: what you built as a file list,
every command with its real exit code, every decision you took that this brief did not take for
you, every measurement behind D9 and the broken tenant-client test, and everything you could not
finish. Commands and exit codes and measurements. No status prose.
