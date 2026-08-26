# Phase 2 progress

> **A dated record of what was said and decided at the time. Not a description of current state —
> [`roadmap.md`](../../../../.claude/product/roadmap.md) is the only authority on that.**

Plan: [`../../plans/2026-08-24-phase-2-identity.md`](../../plans/2026-08-24-phase-2-identity.md)
Branch: `feat/phase-2-identity`

## Task status

| # | Task | Mode | State |
|---|---|---|---|
| 1 | Identity schema, migrations, registry, Membership partial-unique fix | subagent | **Done** — [brief](task-01/brief.md) · [report](task-01/report.md) · [review](task-01/review.md) |
| 2 | `packages/contracts` — identity contracts, Principal, TenantContext | subagent | **Done** — [brief](task-02/brief.md) · [report](task-02/report.md) · [review](task-02/review.md) · [rulings](task-02/rulings.md) |
| 3 | Password hashing and the breach check | subagent | **Done** — [brief](task-03/brief.md) · [report](task-03/report.md) · [review](task-03/review.md) · [rulings](task-03/rulings.md) |
| 4 | Single-use secret tokens | subagent | **Done** — [brief](task-04/brief.md) · [report](task-04/report.md) · [review](task-04/review.md) · [rulings](task-04/rulings.md) |
| 5 | Mail infrastructure and templates | subagent | Not started |
| 6 | Session service | chained with 7 | Not started |
| 7 | Authentication guard, CSRF, CORS | chained with 6 | Not started |
| 8 | Registration and email verification | either | Not started |
| 9 | Login, logout, session endpoint, lockout | chained with 10 | Not started |
| 10 | Password reset | chained with 9 | Not started |
| 11 | TOTP MFA and recovery codes | subagent | Not started |
| 12 | Tenant resolution and the authorization guard | orchestrator | Not started |
| **A** | **Checkpoint — verify, push, CI green, status recorded** | orchestrator | Not reached |
| 13 | Organisations and organisation switching | chained 13→15 | Not started |
| 14 | Memberships, roles, last-owner invariant | chained 13→15 | Not started |
| 15 | Invitations | chained 13→15 | Not started |
| 16 | Web — authentication screens | chained with 17 | Not started |
| 17 | Web — app shell, org switcher, `/settings/security` | chained with 16 | Not started |
| 18 | E2E journey, doc audit, ADR sweep, roadmap | orchestrator | Not started |

## Carry-forward rulings

Rulings from a task carry forward to every later task and are repeated here so a fresh session does
not have to read all previous entries to find them. **A ruling here is not evidence that anything
works** — `roadmap.md` is the only authority on status.

### From Task 1

1. **Migrations are two commits when two invariants are involved.** Task 1 shipped migration A
   (`Membership`) and migration B (identity expansion) separately, and the CHECK constraint was
   moved *into* A once it became clear a clone stopping between them held a soundness gap. **Each
   migration must leave the database sound on its own.**

2. **Editing an applied migration breaks `prisma migrate dev`, not `prisma migrate deploy`.**
   Measured on Prisma 6.19.3: `deploy` does not verify checksums and exits 0 on drifted history;
   `migrate status` does not detect it either. So CI, Testcontainers and fresh clones are unaffected —
   they replay from empty — and the breakage is local, on every `pnpm db:migrate`, until a reset. The
   Task 1 brief originally asserted the opposite and the wrong sentence reached a code comment before
   it was caught.

3. **`pnpm db:reset` cannot be run by an agent.** Prisma 6.19.3 refuses `migrate reset` on detecting
   an AI agent and requires `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION` set to the literal text of
   the user's consenting message, explicitly excluding earlier messages. Never fabricate that string.
   Plan for the operator to run it, or to consent in the moment.

4. **Prisma does not see a partial index or a CHECK constraint in either direction.** It will not
   create them and will not drop them; `migrate diff` emits no `Membership` statement. The plan's
   prediction that `migrate dev` would offer to re-add the full `@@unique` was disproved by
   measurement. The two real hazards both need a human: `prisma db push` (builds from
   `schema.prisma` alone, never replays history) and someone "restoring" the absent `@@unique`.

5. **Both prefix registries must be extended together.** `packages/db/src/id.ts`'s `ID_PREFIXES` and
   `packages/contracts/src/ids.ts` are independent lists with no cross-check, and they already
   disagree. **Task 2 owns extending both**, plus a prefix for `IdentityProviderLink`, which the plan
   omits. `parseIdPrefix` hard-codes three characters.

6. **`Session.status` has no `@default`, deliberately.** Every `session.create` must state it, so
   forgetting is a compile error rather than a silently privileged session. **This constrains Task 6.**

7. **An unconfirmed `MfaFactor` occupies the `(userId, type)` unique slot.** An abandoned enrolment
   permanently blocks re-enrolment with P2002. **Task 11 must upsert or delete-then-create.**

8. **`MfaFactor.secretKeyVersion` exists but nothing writes it.** NULL means "the only key that has
   ever existed". **Task 11 owns making rotation real**; if it never writes the column, the column is
   dead weight rather than cheap insurance.

9. **The four new user-owned tables have no RLS, so the CI tenant-scoping check will never flag a
   query against them.** Registering a model as deliberately-global is exactly what exempts it. Any
   handler taking a `userId` from a request path must prove the caller *is* that user before reading
   `MfaFactor`, `RecoveryCode`, `VerificationToken` or `IdentityProviderLink` — there is no database
   layer behind it. **Binds Tasks 11 and 14.**

10. **A `Membership` write must set `status` and `deletedAt` together.** The CHECK constraint makes
    `REMOVED` and soft-deleted the same fact. A bare `status: 'REMOVED'` is now an invalid write.
    **Binds Task 14's removal path.**

### From Task 2

Full reasoning and cost-if-wrong for each is in [`task-02/rulings.md`](task-02/rulings.md).

11. **The plan's password citation is false.** The plan (line 329) and Task 2's brief both say "no
    maximum below 128, per `authentication.md` §2". `grep -rn "128" .claude/` proves the string is
    in neither authentication document — `security/authentication.md` §2 says only "Minimum 12
    characters. No composition rules, no forced rotation." The behaviour shipped is
    `.min(12).max(256)`, which is right, but **the 256 ceiling stands on the Argon2id input-cost
    argument alone.** Do not re-quote the phrase. This is the class of defect the phase's prose
    rules exist for, and it reached a code comment before the reviewer caught it.

12. **`TenantContext` now exists under that name in two packages** — `@sentinel/contracts` (four
    fields: `organizationId`, `membershipId`, `roleKey`, `permissions`) and `@sentinel/db`
    (`organizationId` only) — both exported from their package indexes. **A file importing both
    must alias one.** Unresolved by design; **Task 12 owns deciding** whether the db one is
    renamed, since Task 12 is where both are used together for the first time.

13. **Restating a Prisma enum in contracts requires a parity spec, not a comment.** Task 2's first
    round restated three enums and claimed a spec made drift visible; the reviewer disproved it by
    adding a value to `schema.prisma` and watching both specs stay green.
    `packages/db/src/enum-parity.spec.ts` now cross-checks against `Prisma.dmmf.datamodel.enums`
    with a `DB_ONLY_ENUMS` allowlist. **Any later task adding an enum must extend one list or the
    other**, and adding a *new* Prisma enum turns that spec red until it does. Same rule for ID
    prefixes via `id-prefix-parity.spec.ts`.

14. **`UNKNOWN_FIELD` now has a producer, and the split is asymmetric.** `ZodValidationPipe`
    raises it at 400 only when **every** Zod issue is `unrecognized_keys`; a mixed failure stays
    `VALIDATION_ERROR` and still lists the unrecognised keys in `details.fields`. **Binds every
    task that adds an endpoint** — a validation failure must never hide behind a different code.

15. **`updateOrganizationRequestSchema` is a `ZodEffects`.** `.extend()`, `.partial()` and
    `.merge()` are unavailable on it. **Task 13 must rebuild the schema, not extend it**, when it
    adds `requireMfa` or `enforcedEmailDomain`.

16. **`Principal` and `TenantContext` are plain TypeScript types with no Zod schema, deliberately.**
    A `principalSchema.parse(req.body)` would mint a principal out of attacker-controlled JSON.
    **Binds Tasks 7 and 12:** construct them from database state, never parse them. If a principal
    must reach the wire, define a separate response schema — `sessionResponseSchema` is the
    existing example, and it deliberately omits `sessionId`.

17. **Timestamps in response schemas are UTC-only** (`z.string().datetime()`, no `offset: true`),
    per `api/conventions.md` §3's "always UTC". Narrowing had to happen before any endpoint
    published one; widening later is additive.

18. **`loginRequestSchema` has no `rememberMe`** although `Session.rememberMe` exists from Task 1.
    **Task 9 owns adding it** — adding an optional field to a `.strict()` schema is additive,
    removing one is not.

19. **MFA enrolment contracts do not exist and Task 11 owns them.** Task 2 defined only
    `mfa/verify`, which `api/authentication.md` §2 documents exactly.

### From Task 3

Full reasoning and cost-if-wrong for each is in [`task-03/rulings.md`](task-03/rulings.md).

20. **Argon2 parameters live in `apiEnvSchema`, not in constants and not in `sharedEnvSchema`.**
    ADR-0014's reason is operational tuning. The second reason emerged during the task: config-held
    parameters are what let the timing proof run cheaply enough to live in the unit suite at all.

21. **`verify()` takes a nullable stored hash, and that signature is the security control.**
    `verify(storedHash: string | null, password)` performs a full Argon2id verification against a
    dummy built from live parameters when the hash is `null`. **Task 9 cannot express "no such user,
    skip the hash" without deliberately not calling this function.** Wrap it if the shape is
    awkward; never add an overload that lets the caller skip verification.

22. **The timing spec runs at reduced Argon2 parameters, and the reason originally written beside
    it was false.** The brief justified the reduction on production parameters costing "minutes";
    measured, a verification is ~36 ms and the spec would cost ~1.9 s. The reduction stands on a
    different argument — the property is parameter-independent, so real parameters buy CI flake
    risk rather than proof. **A decision can be right while the reason written beside it is false,
    and the false reason is still a defect.**

23. **250 ms is a documented target, never an observed cost.** ADR-0014 says the target is untuned.
    No comment, report or document may state it as a measurement. Same class as ruling 11.

24. **Timing equality holds against the dummy, not against legacy hashes after a parameter raise.**
    A pre-raise stored hash verifies at old, cheaper parameters while an absent account verifies at
    current ones — measured 35.9 ms vs 7.7 ms, 4.6×. It is an enumeration oracle pointing the
    opposite way from the one Task 3 closes, and **it opens on the day an operator raises the
    parameters. Binds Task 9.**

25. **A corrupted stored credential is silently indistinguishable from a wrong password.**
    `runVerification` swallows every argon2 error, correctly (the message derives from the stored
    hash). Nothing logs it. **Task 9 owns adding a safe signal**, where a user id exists to attach.

26. **`PasswordBreachedError` already exists — Task 8 must not build a second.** 422 per
    `api/conventions.md` §2, code `PASSWORD_BREACHED`, and its spec pins that nothing hex-shaped
    reaches the message or details.

27. **`PASSWORD_BREACHED` is in both error lists, which still have no parity spec between them.**
    Same shape as rulings 5 and 13. Any later task adding a code adds it to both; a task with spare
    room should build the spec, following `packages/db/src/enum-parity.spec.ts`.

28. **The breach check is off by default and fails open, so no task may assume it ran.** Tasks 8
    and 10 treat a breached password as a refusal that *may* happen, never as a guarantee that a
    stored password is unbreached. **Owed and not built:** a metric and alert on the fail-open rate —
    ADR-0015 names its absence as a real gap.

29. **`needsRehash` is one-directional and false whenever `valid` is false.** A hash stronger than
    current configuration is never downgraded; a credential that just failed is never rehashed.

30. **`apiEnvSchema` is now a `ZodEffects` — the same trap as ruling 15.** `.extend()`,
    `.partial()`, `.merge()` and `.shape` are unavailable. **A later task adding an API environment
    variable adds it inside the base object, before the refinement.** `pnpm typecheck` catches a
    mistake here.

### From Task 4

Full reasoning and cost-if-wrong for each is in [`task-04/rulings.md`](task-04/rulings.md).

31. **`issue` holds `pg_advisory_xact_lock(hashtext('vtk:<userId>:<purpose>'))` as the first
    statement in its transaction.** Without it, supersession does not survive concurrency — under
    READ COMMITTED a second transaction cannot see the first's uncommitted INSERT, measured at ten
    live-token pairs out of ten. A transaction is not a lock. **Any later task writing a
    supersede-then-insert pair against a non-unique index needs the same thing.**

32. **A partial unique index on `(userId, purpose) WHERE consumedAt IS NULL` is owed and not
    built.** The application lock is currently the only thing holding §6's invariant, so a writer
    that bypasses `TokenService` reintroduces the defect silently. Needs hand-written SQL — Prisma
    cannot express it (ruling 4). **The next task that opens a migration owns it.**

33. **The integration suite runs sequentially, and that is load-bearing.** `fileParallelism: false`
    in `vitest.workspace.ts` had never been in force (Vitest reads the pool's worker count from the
    root config); root `test:integration` now passes `--no-file-parallelism`. Two suites share the
    `ratelimit:login:*` namespace on the one compose Redis, and one deletes it in a `beforeEach`.
    **Do not restore parallelism without namespacing the shared services first**, and prefer a
    spec's own container (`startPostgresHarness()`) where isolation actually matters.

34. **A secret in a link goes in a `?token=` query parameter.** `key` and `code` were removed from
    the redaction value-pattern — `redact()` blanks the whole field on a match, and both names
    collide with object-storage URLs and this repository's own error codes. **Binds Tasks 5 and
    15:** a link carrying its secret under any other parameter name reaches the logs intact.

35. **`@sentinel/db/testing` is fenced by `no-restricted-imports` and is for spec files only.** It
    returns the schema-owner DSN, which no RLS policy applies to. Recorded in
    `coding-standards.md` §6 beside the two rules it sits with.

36. **Redaction residuals, measured and left open.** A token in a **path segment**
    (`/verify/<token>`) leaks; so does a percent-encoded URL nested in another URL, `?t=<token>`,
    and `X-Amz-Signature=` (the pattern anchors on `[?&#]` immediately before the name). **Binds
    Task 5:** build the link as a query parameter, never a path segment.

37. **`consume` asserts nothing about the user it returns.** A `LOCKED` or suspended user's tokens
    still redeem — the FK cascade only clears a *deleted* user's rows, and ruling 9 already records
    that there is no RLS behind this table. **Tasks 8, 10 and 15 must check `User.status` after
    `consume` returns.**

38. **`TokenService` writes no `AuditEvent`, and the raw token never enters one.**
    `AuditEvent.organizationId` is NOT NULL with a `Restrict` FK, and a registering user has no
    organisation. **Binds Tasks 8, 10 and 15:** the audit event is the endpoint's to write.

39. **An agent that mutates `schema.prisma` must run `prisma generate` after reverting.** The Task 4
    reviewer left a `MUTANT_PURPOSE` value in the generated client with a clean `git status`,
    because `packages/db/generated/` is untracked. `enum-parity.spec.ts` and `check:registry` both
    caught it. **A clean `git status` is not evidence that a mutation was undone.**

40. **`pnpm test` and `pnpm lint` can both be green while `pnpm typecheck` is not.** A stub missing
    a method the production type requires (TS2345) survived both. Run all three before claiming a
    tree is clean.

## Pause state

**2026-08-26 — Task 4 complete and verified; Task 5 is next.**

Task 4 landed the two-layer secret-token discipline in `apps/api/src/modules/auth/`:
`secret-token.ts` (mint 256 bits, SHA-256, base64url — the primitive Task 6 will use for
`Session.tokenHash` and Task 15 for `Invitation.tokenHash`) and `TokenService` (issue and consume
`VerificationToken` rows for the two purposes the Prisma enum has). Plus `TOKEN_INVALID` in both
error lists with the parity spec ruling 27 had been asking for since Task 3, three TTL variables
on `apiEnvSchema`'s base object, and a measured fix to the redacting logger. Evidence is in
`roadmap.md`; the implementer's commands and exit codes are in [`task-04/report.md`](task-04/report.md).

**One High, three Medium, five Low — and the High was the same defect shape the task existed to
eliminate, one layer up.** `consume` was built correctly as a conditional update whose affected-row
count is the decision, and the concurrency test for it is excellent. Nobody pointed the same weapon
at `issue`, whose supersede-then-insert does not survive concurrency inside a transaction: measured
at two live tokens in ten rounds of ten before the fix, one in ten after. Ruling 31. The citation
pass found **no false sentence about a document** for the second task running.

**The intermittent integration suite is resolved, and it was never Task 4's code.** Two latent
defects: `fileParallelism: false` had never been in force since the day it was written (Vitest
resolves the pool's worker count from the root config, not a project's — measured, 140.60s of test
time inside a 19.72s wall clock), and `rate-limit.integration.spec.ts`'s `beforeEach` deletes
`ratelimit:login:*`, which is the namespace `sliding-window.integration.spec.ts` writes its keys
in. Root `test:integration` now passes `--no-file-parallelism`; five consecutive green runs
against roughly one failure in two before. Ruling 33.

**The branch history was rewritten** so `apps/api/openapi.json` moves with the contracts commit
that changes it. Before that, four commits failed `pnpm check:openapi` and a change to the shipped
API contract sat inside a commit typed `docs(ledger):`. Ruling 39 in `task-04/rulings.md`. The tree
was proven byte-identical to the pre-rewrite tree before the backup branch was deleted.

**Nothing authenticates anybody yet.** `AuthModule` now registers three services and **no
controller**; the committed `openapi.json` still publishes four routes, and `apps/web/app/(auth)/`
still holds a layout with no routes under it. A service nothing calls is not a feature.

**Branching. Task 4 is on `main`.** Built on `feat/phase-2-task-04`, cut from `main`, one branch
per task and one PR per task. **PR #8 was rebase-merged on 2026-08-26 at 01:10Z** (merge commit
`3473a6d`) and the branch was deleted, so `feat/phase-2-task-04` is spent history. CI was green on
`ubuntu-latest` before the merge (run `32917703646`, 3m24s), with the integration stage reporting
12 files / 163 tests. **Cut Task 5 from `main`.**

**Next action:** Task 5 — mail infrastructure and templates — in a new session, starting with
`sentinel-phase`. It owes **ADR-0016** (the mailer port and the SMTP-against-Mailpit decision),
which is written and committed *before* the implementation, as ADRs 0014 and 0015 were.

Before starting Task 5, read carry-forward rulings **34** and **36**: Task 5 owns the link format,
and a secret must travel in a `?token=` query parameter. A path-segment link
(`/verify/<token>`) is covered by no redaction this repository has, and was measured leaking a
real token verbatim.

**Tasks 8, 10 and 15 inherit three items** — rulings 37 (check `User.status` after `consume`), 38
(the `AuditEvent` is the endpoint's, and the raw token never enters its metadata) and 32 (the
partial unique index is owed by whichever task next opens a migration). Put them in those briefs
when they are written.

**Task 9 still inherits rulings 24 and 25** from Task 3, unchanged.
