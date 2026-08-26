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
| 5 | Mail infrastructure and templates | subagent | **Done** — [brief](task-05/brief.md) · [report](task-05/report.md) · [review](task-05/review.md) · [rulings](task-05/rulings.md) |
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

### From Task 5

Full reasoning and cost-if-wrong for each is in [`task-05/rulings.md`](task-05/rulings.md).

41. **A secret in a link travels as `?token=` on a query string, and the link is built from
    `WEB_BASE_URL` alone.** This is carry-forward rulings 34 and 36 discharged by the task that
    owned the format. `buildTokenLink` takes a base URL and a token and cannot see a request, so a
    host-header-derived link is not merely forbidden but unexpressible. **Binds Task 15**, which
    sends the invitation link, and Tasks 16–17, which build the screens those links land on:
    `/verify-email`, `/reset-password` and `/accept-invitation`, each reading `?token=`.

42. **The recipient guard enforces one address, not the absence of a line break.** nodemailer parses
    `to` as a comma-separated **list** and issues one `RCPT TO` per entry — measured delivering a
    password-reset message to an attacker address on the right of a comma. It also does **not**
    refuse a CRLF recipient on its own, so this guard is the only line of defence below Zod.
    Conservative by design: comma, semicolon, angle brackets, whitespace, and anything without
    exactly one `@` are all refused. **Any later transport that takes an address does the same.**

43. **There are seven email templates, not six, and the invitation is one of them.** Built in Task 5
    along with the rest, so it inherits the registry's assertions like every other member. **Task 15
    does not add a template** — it adds the endpoint that sends one that already exists. The next
    template added is the eighth and no task owns it.

44. **Mail is sent after the transaction commits, never inside it.** A send inside the transaction
    either holds a transaction open across network I/O to a third party or sends "your password was
    changed" for a change that then rolls back. In Task 5 this is a docblock and no test, because no
    endpoint exists to demonstrate it — deliberately not faked. **Binds Tasks 8, 10, 11 and 15**,
    and Task 8 sets the pattern the other three copy.

45. **A failed send is not retried, not queued, and nothing alerts on it.** ADR-0016 and
    `integrations.md` §7 both name it. **Task 8 must ship a resend path** rather than treating the
    first verification send as authoritative; a failed *security notice* is the worse case, because
    the signal that would reveal an account takeover simply never arrives. **Owed by Phase 4**, which
    brings the queue.

46. **`escapeHtml` in `emails/` defends a quoted attribute or an element body, and nothing else.** It
    leaves `/`, `=`, space, `(`, `{`, `;` and `:` untouched, so an **unquoted** attribute added to
    `layout.ts` later inherits an escaper that does not defend it. A value interpolated into a
    `style`, a `<script>` or a URL context needs its own encoder. Scheme checking is separate and
    explicit — `renderEmail` refuses an action URL that is not http or https.

47. **A token quoted back by a relay *without* its `?token=` prefix still reaches a log line.**
    Measured through the real adapter and the real logger: connection-refused and TLS-mismatch are
    clean, a token inside a rejected `?token=` URL **is** redacted, and a bare token in a relay's
    rejection text is not. Not closed, because widening the value pattern is what carry-forward
    ruling 34 records as dangerous. **Owed by whichever task next touches `redaction.ts`**, together
    with ruling 36's other residuals.

48. **`apiEnvSchema` and `webEnvSchema` each declare their own `WEB_BASE_URL` and `API_BASE_URL`.**
    A rule applied to one is half-applied. Both now constrain the scheme to http/https. Related:
    **a failed `.url()` check marks a Zod result dirty, not aborted, so a `superRefine` still runs
    over the invalid value** — an unguarded `new URL()` in a refinement throws past `loadEnv`'s
    error envelope. And `describeIssue` now renders an authored `params.rule` for a `custom` issue,
    so a cross-field rule can say why it failed instead of "failed validation (custom)".

## Pause state

**2026-08-26 — Task 5 complete and verified; Task 6 is next.**

Task 5 landed a `Mailer` port with one SMTP adapter (`apps/api/src/infrastructure/mail/`) and seven
email templates behind a registry (`apps/api/src/modules/auth/emails/`). Every email this product
sends is a real SMTP message: the integration spec sends through the real adapter to the compose
Mailpit and reads the message back over Mailpit's HTTP API, asserting the recipient, the subject,
both MIME parts, and the `?token=` value parsed out of a real `URL`. **ADR-0016 was written and
committed before any implementation commit** — `09:28:54` against a first implementation commit at
`09:38:20`, verified by the reviewer rather than asserted. Evidence is in `roadmap.md`.

**One High, four Medium, five Low, and the High was in a control the implementer volunteered.**
`SmtpMailer` refused a recipient containing CR/LF/NUL — nobody asked for that guard — but not a
comma, and nodemailer parses `to` as an address **list**. Measured twice: two `RCPT TO` commands
from one `send`, and against real Mailpit an attacker address on the right of the comma received a
password-reset message. The same probe showed nodemailer does not refuse a CRLF recipient on its
own, so the guard was the only line of defence below Zod. Ruling 53. **A guard that half-holds is
still better than the absent guard it replaced** — its existence is what gave the review something
specific to attack.

**The citation pass found two false sentences and confirmed everything else reproduced exactly** —
every command, exit code, file line count and commit SHA in the implementer's report, re-run rather
than read. The two: a claim that Task 15 would add "the seventh template" when the registry already
holds seven and the invitation is one of them (ruling 56), and a literal "appears in no file" that
was false as written while its intended meaning was true (L4). The first was the dangerous one, and
it was heading for this file's carry-forward section — the exact path that produced five of Phase
1's twelve instances.

**Ruling 45 is the strongest thing in the change and it was verified destructively.** A deliberately
broken extra template fired **eight** assertions naming every planted defect; leaving it
unclassified fired a ninth; omitting it from `CASES` produced the promised `TS2741`. Rulings 42, 48,
49, 50 and 52 all held under measurement, including a real `dist/main.js` boot with nothing on the
SMTP port still answering `/health/live 200`.

**Nothing authenticates anybody yet, and nothing sends an email either.** `pnpm check:openapi` still
publishes **four routes**. The mailer has no caller: `Mailer.send` is invoked by specs and by
nothing else, so the six notice and verification messages exist as templates and a transport, not as
mail any user receives. `apps/web/app/(auth)/` still holds a layout with no routes under it.

**A live-format token reached the ledger, and the history was rewritten to purge it.** It was
redacted in the working tree by `0088852`, but survived at `aaa6d39` and `d5161c5`; since `main`
blocks force pushes and requires linear history, the merge would have made it permanent. The
operator chose the rewrite before the branch was pushed. Tree byte-identical to the pre-rewrite tree
(`4f1ff58…` both sides, empty diff against the backup), full suite re-run afterwards, backup deleted
only then. Ruling 57. **The value was inert** — minted for a Mailpit send, no `VerificationToken`
row, no account — and it was purged anyway, because a repository already carrying a red GitGuardian
check on every pull request it has had does not need a genuine-looking secret added to the pile.

**Branching. Task 5 is on `feat/phase-2-task-05`, cut from `main` at `c641b9d`, unpushed, with no
pull request.** One branch per task and one PR per task, as Tasks 1–4 were.

**Next action:** Task 6 — the session service: issue, rotate, revoke, cache — in a new session,
starting with `sentinel-phase`. **Task 6 is chained with Task 7** (authentication guard, `Principal`,
CSRF, CORS) under one implementer, because a cold agent re-invents conventions rather than
inheriting them. Task 7 owes **ADR-0017** (explicit CORS allowlist with `credentials: true`, not a
Next-side proxy), written and committed before the implementation as ADRs 0014, 0015 and 0016 were.

Before starting Task 6, read carry-forward rulings **6** and **31**. Ruling 6: `Session.status` has
no `@default`, deliberately, so every `session.create` must state it and forgetting is a compile
error rather than a silently privileged session. Ruling 31: `TokenService.issue` holds
`pg_advisory_xact_lock(hashtext('vtk:<userId>:<purpose>'))` as the first statement in its
transaction, because a transaction is not a lock — **any supersede-then-insert pair against a
non-unique index needs the same thing**, and session rotation is exactly that shape.

**Tasks 8, 10 and 15 inherit four items** — rulings 37 (check `User.status` after `consume`), 38
(the `AuditEvent` is the endpoint's, and the raw token never enters its metadata), 32 (the partial
unique index is owed by whichever task next opens a migration) and now 44 (mail is sent after the
transaction commits, never inside it). **Task 8 additionally owns a resend path**, per ruling 45.

**Task 9 still inherits rulings 24 and 25** from Task 3, unchanged.
