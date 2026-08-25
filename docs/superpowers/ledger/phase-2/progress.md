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
| 4 | Single-use secret tokens | subagent | Not started |
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

## Pause state

**2026-08-25 — Task 3 complete and verified; Task 4 is next.**

Task 3 landed `PasswordService` and `BreachCheckService` in `apps/api/src/modules/auth/`, six
environment variables on `apiEnvSchema`, the `PASSWORD_BREACHED` code in both error lists, a 422
`PasswordBreachedError` with no producer until Task 8, and ADRs
[0014](../../../../.claude/decisions/ADR-0014-argon2-implementation.md) and
[0015](../../../../.claude/decisions/ADR-0015-password-breach-check-fails-open.md) — both written
and committed **before** the implementation, deliberately. Evidence is in `roadmap.md`; the commands
and exit codes are in [`task-03/report.md`](task-03/report.md).

**Three Medium findings, eight Low, no High — and for the first time on this branch, the citation
pass found no false sentence about a document.** Roughly forty claims checked, no invented
quotation, no misattribution. Both Medium code findings were tests that stayed green under a real
violation, which is Task 2's defect shape found in two new places and fixed. Dispositions are in
[`task-03/rulings.md`](task-03/rulings.md).

**The worst finding was the orchestrator's own brief**, not the implementer's work: it justified
reducing the timing spec's Argon2 parameters on a cost that was wrong by about 100×. Ruling 22.

**Nothing authenticates anybody yet.** `apps/api/src/modules/` now holds `auth` beside `health`, but
`AuthModule` registers two providers and **no controller**; the committed `openapi.json` still
publishes four routes, and `apps/web/app/(auth)/` still holds a layout with no routes under it. A
service nothing calls is not a feature.

**Branching changed, and a resuming session must not miss it.** PR #5 was **rebase-merged** into
`main` on 2026-08-25 at 04:37Z, so `feat/phase-2-identity` is spent history — identical tree,
duplicate commits. Task 3 was built on **`feat/phase-2-task-03`, cut from `main`**, and **PR #6
rebase-merged it into `main` at 15:55Z the same day**. Cut later tasks from `main` the same way,
one branch per task, one PR per task.

**Task 3 is on `main`.** Start Task 4 from `main`, not from any `feat/` branch — every one of them
is now behind or duplicate.

**Next action:** Task 4 — single-use secret tokens — in a new session, starting with
`sentinel-phase`. It is a self-contained task: fresh implementer subagent plus a fresh adversarial
reviewer. It depends on Task 2 only, so nothing from Task 3 blocks it.

Before starting Task 4, read carry-forward rulings **14** (a validation failure must never hide
behind a different code), **27** (an error code goes into *both* lists, which still have no parity
spec) and **30** (`apiEnvSchema` is a `ZodEffects` now — add variables inside the base object, not
by extending it). Ruling 27 matters most: Task 4 mints and hashes tokens, and it is the kind of task
that adds a code.

**Task 9 inherits two open security items** recorded as rulings 24 and 25, and neither is a defect
in Task 3's code: timing equality does not hold against stored hashes written before a parameter
raise, and a corrupted stored credential is silently indistinguishable from a wrong password. Put
both in Task 9's brief when it is written.
