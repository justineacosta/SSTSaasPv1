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
| 6 | Session service | chained with 7 | **Done** — [brief](task-06/brief.md) · [report](task-06/report.md) · [review](task-06/review.md) · [fixes](task-06/fixes.md) · [rulings](task-06/rulings.md) |
| 7 | Authentication guard, CSRF, CORS | chained with 6 | **Done** — [brief](task-07/brief.md) · [report](task-07/report.md) · [review](task-07/review.md) · [fixes](task-07/fixes.md) · [rulings](task-07/rulings.md) |
| 8 | Registration and email verification | subagent (fix round: orchestrator) | **Done** — [brief](task-08/brief.md) · [report](task-08/report.md) · [review](task-08/review.md) · [dispositions](task-08/fix-brief.md) · [fixes](task-08/fixes.md) |
| 9 | Login, logout, session endpoint, lockout | chained with 10 | **Done** — [brief](task-09/brief.md) · [report](task-09/report.md) · [review](task-09/review.md) · [dispositions](task-09/fix-brief.md) · [fixes](task-09/fixes.md) · [fix review](task-09/fix-review.md) |
| 10 | Password reset | chained with 9 | **Done** — [brief](task-10/brief.md) · [report](task-10/report.md) · [review](task-10/review.md) · [dispositions](task-10/fix-brief.md) · [fixes](task-10/fixes.md) · [fix review](task-10/fix-review.md) |
| 11 | TOTP MFA and recovery codes | subagent | **Done** — [brief](task-11/brief.md) · [report](task-11/report.md) · [review](task-11/review.md) · [dispositions](task-11/fix-brief.md) · [fixes](task-11/fixes.md) |
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
### From Task 6

Full reasoning and cost-if-wrong for each is in [`task-06/rulings.md`](task-06/rulings.md).

49. **An equality assertion between two values both derived from `Date.now()` in the same test is
    an assertion about scheduling, not about behaviour.** Task 6's rotation test compared a
    predecessor's `now + 7 days` against a successor's, so a mutant that *restarts* the absolute
    clock produced an identical ISO string whenever both readings landed in the same millisecond —
    it caught the mutant on one run and missed it on the next. Pin one side to a fixed instant.
    **Binds Tasks 9, 10, 11 and 13**, all of which rotate sessions and test an expiry.

50. **`SessionService.rotate` requires the caller to state the successor's status, and a
    `PENDING_MFA` -> `ACTIVE` promotion must carry an `mfaCompletedAt`.** The schema defaulted
    `status` to `'ACTIVE'`, so `rotate({ sessionId })` on a ten-minute pending session returned a
    thirty-day `ACTIVE` credential with nothing proved — carry-forward ruling 6's defect one layer
    up, in the one call that can *raise* privilege. A promotion without evidence now throws
    `MFA_EVIDENCE_REQUIRED`. **Binds Task 11**, the one legitimate promoter: pass the instant the
    factor was actually proved. A refusal throws rather than returning `null`, because `null`
    already means "there was nothing to rotate" and a caller would retry a programming error
    forever.

51. **Bulk revocation poisons the cache twice, and the second pass is what makes it immediate.**
    A session created between `listLiveForUser` and `revokeLiveForUser` is revoked by the
    `updateMany` — which evaluates its predicate at execution time — while its hash was never in
    the first poison list, and the review measured it resolving as valid from a warm cache entry
    **with Redis healthy**. **Binds Tasks 10 and 14:** what remains genuinely open is a session
    created *after* the write, so a password change must write the new hash **before** revoking and
    member removal must write the membership change first.

    **The last sentence used to read "otherwise a racing login mints a session with the old
    credential once the revocation has finished", and that ordering is necessary but NOT
    sufficient — corrected in Task 10 after measuring it.** Writing the hash first narrows the
    window; it does not close it. A login whose credential read preceded the reset's commit and
    whose `Session` insert follows the reset's revoke is never swept, because `updateMany` cannot
    revoke a row that does not exist yet. Measured at **25 of 25** such logins surviving a
    completed reset, each a fully privileged session lasting up to 30 days. What closes it is on
    the login path — see ruling 82 — and **Task 14's member removal has the same shape with no
    equivalent check.**

52. **Revocation has one residual that no code here can close: Redis unreachable at the moment of
    revocation.** The row is revoked, no tombstone can be written, and an entry cached before the
    outage serves until it expires — bounded by `SESSION_CACHE_TTL_SECONDS`, default 60. The
    component that would have to be told is the one that is down. Stated in `authentication.md` §3
    rather than hidden, and it is the reason that variable is short and configurable.

53. **ADR-0005's "revocation deletes the cache entry and the row together" is insufficient as
    written, and the ADR is deliberately not edited.** A delete loses the race in either order: a
    resolve that has already read a live row can land its cache write afterwards. The mechanism
    that keeps the promise is a tombstone plus a Lua compare-and-set that refuses to overwrite one.
    `CLAUDE.md` makes an accepted ADR immutable, and the decision ADR-0005 records is unchanged —
    so `security/authentication.md` §3 carries the correction and names the ADR as predating the
    measurement. **If a second sentence in ADR-0005 is ever found wrong, supersede it rather than
    accumulate a third pointer.**

54. **`cookies.ts` has no cookie *parser*, deliberately, and Task 7 owns building one.** Task 6
    issues credentials and never inspects one. A parser sitting here unused would be a surface for
    a caller to authenticate against before a guard exists to say what authentication means.
### From Task 7

Full reasoning and cost-if-wrong for each is in [`task-07/rulings.md`](task-07/rulings.md).

55. **There is no runtime signal for an unresolvable rate-limit scope, and the sentence that said
    otherwise was the orchestrator's.** `generalSession`'s `perPrincipal` limit resolves nothing —
    the guard runs before authentication by design — and the `unresolvedWarned` warn **cannot
    fire** for it: `rate-limit.guard.ts:324` requires `failMode === 'closed'` and at least one
    resolved scope, and `generalSession` is fail-open with `perPrincipal` as its only scope. The
    surviving line is at `debug`, which `LOG_LEVEL=info` does not emit. `abuse-prevention.md` §1's
    1000/min per principal is therefore promised and enforced by nothing. **The false claim came
    from the Task 7 brief and reached a code comment and two documents** — the propagation path
    that produced five of Phase 1's twelve. **Binds every future brief: a ruling asserting that a
    mechanism exists is a claim, checked before dispatch.**

56. **CSRF skips `@Public()` routes, and login CSRF is Task 9's with its own mechanism.**
    `CsrfGuard` read no access metadata, so any unsafe public route refused with 403 whenever the
    browser carried a session cookie — unsatisfiable, because the expected token derives from the
    `HttpOnly` cookie a page cannot read. **Task 9's login endpoint would have inherited a refusal
    with no client-side remedy**, failing for exactly the users who already had a stale session. A
    cross-site login `POST` carries no session cookie, so double-submit has nothing to bind to;
    **Task 9 brings its own mechanism** and must not assume this guard covers it.

57. **Node's repeated-header semantics differ per header, and they are now measured** (v26.7.0,
    raw socket): `Cookie` joins with `'; '`, an ordinary custom header joins with `', '`,
    `Set-Cookie` arrives as an array, and **`Authorization` keeps the first value and silently
    drops the second.** **Binds whichever task builds API-key authentication** — a header the
    parser never sees is a worse failure than one it mis-parses.

58. **A spec whose fixtures all sit on one side of the branch under test cannot fail for the right
    reason.** Every route in the CSRF spec was `@Public()`, which is why the suite could not see
    ruling 56's hole — and why exempting public routes would have made nineteen tests *vacuous*
    rather than red. Third instance of this family in three disguises, after Task 6's ruling 49 and
    Phase 1's `.test.ts` files that executed nothing. **When a fix exempts a case, check whether
    the existing tests all live inside the exemption before believing the fix.**

59. **Preflight `OPTIONS` reach neither the rate limiter nor the logging interceptor.** The CORS
    middleware answers them in `configureApp`, before the guard and interceptor pipeline, so every
    unsafe browser request produces one unmetered, unlogged request. Recorded in the middleware and
    in `backend.md` §3; deliberately **not** added to ADR-0017, which is immutable once accepted.
    **Owed by whichever task splits the limiter into an early per-IP stage.**

60. **`Cross-Origin-Resource-Policy: same-origin` does not block a CORS-mode credentialed fetch,
    and this is measured rather than read.** Chromium 151.0.7922.34 against the real `dist/main.js`:
    the credentialed fetch succeeded, the cookie round-tripped, an unknown origin got no
    `Access-Control-Allow-Origin` at all, and the same URL in `no-cors` mode was blocked by CORP —
    which proves CORP is live rather than absent. **The 401 envelope is readable cross-origin**,
    which is what makes the `UNAUTHENTICATED`/`SESSION_EXPIRED` distinction usable by a browser.
    **Task 16 can stop carrying the assumption.**

61. **A metadata exemption must be tested at the class level, not merely implemented there.**
    `@AllowPendingMfa()` is `MethodDecorator` and the guard reads `getHandler()` only — correct, and
    until the fix round nothing held it there: widening to `getAllAndOverride([handler, class])`
    left 1000 unit and 205 integration tests green. **This codebase shipped that exact bug once**
    (`@RateLimitExempt()`, where one class-level line disabled every limit beneath it). Narrowing
    the type is half the control; the class-level test is the other half, and it needs an
    inheritance case because `getAllAndOverride` walks the prototype chain.

### From Task 8

Full reasoning and cost-if-wrong for each is in [`task-08/fixes.md`](task-08/fixes.md) and
[`task-08/review.md`](task-08/review.md).

62. **An audit event for an action with no organisation goes in `PlatformAuditEvent`, not in
    `AuditEvent` with a relaxed column.** ADR-0019. `AuditEvent` carries RLS
    `USING/WITH CHECK ("organizationId" = current_setting('app.organization_id', true))`, so a
    nullable column does not merely need a policy edit — the insert is **refused**, measured twice
    (orchestrator and reviewer independently) with `new row violates row-level security policy`.
    **Binds Tasks 9, 10 and 11**, whose login, reset and MFA events also happen with no
    organisation in hand, and Phase 3's `/audit-logs`, which must union two tables for the
    platform-admin view `audit.md` §6 describes.

63. **A message this product sends to one person must never render text a different, unauthenticated
    person chose.** H1. `registrationAttempt` rendered the caller's `User-Agent` as `Device: <value>`
    in a notice mailed to the account owner — 512 characters of attacker text, a URL included,
    under a footer promising the message contains no link. The fix is a type that cannot carry the
    value, not a filter: a denylist over attacker-controlled text is a defect waiting for a new
    encoding. **Binds every later notice**: the other four templates legitimately render a device
    string because there it describes the recipient's *own* session, and `registry.spec.ts`
    partitions the two kinds so a new template must choose a side. Attacker-supplied strings belong
    in the audit row, which an operator reads, not in a message a third party reads.

64. **A route's rate-limit class must be asserted on the shipped handler, not on the config table.**
    M1. `rate-limit.config.spec.ts` asserts the table value by value and
    `rate-limit.integration.spec.ts` drives a fixture controller, and with both green all three
    routes could be downgraded to fail-open `generalSession`, or lose their decorators entirely,
    with the whole eleven-command gate passing. A silently defaulted route produces no log line at
    the default level (ruling 55), so nothing would ever say the limit had stopped applying.
    **Binds every task that adds a route**: `auth.controller.spec.ts` is the pattern, and its
    exhaustiveness test fails when a handler arrives without a row.

65. **A migration comment is immutable the moment it runs, so measure before applying.** Task 8
    shipped one unmeasured sentence in an applied migration — that replacing the append-only
    trigger function changes `AuditEvent`'s message, which measurement showed it does not, because
    `TG_TABLE_NAME` on that table *is* `AuditEvent`. It is **deliberately not corrected**: editing
    an applied migration changes its checksum and breaks `prisma migrate dev` for every developer
    until a reset that ruling 3 says an agent cannot perform. One misleading clause is cheaper than
    the operator's database, and the real lesson is upstream.

66. **A test that passes both before and after the mutation is not a test, and a fake's default can
    make it one.** L4's first fix issued a token, deleted the user and asserted the refusal — and
    passed, because the identity fake's `updateMany` always reports `count: 0`, so `verify` threw at
    `consumed === null` and never reached the branch under test. Only re-running the mutation caught
    it. **Before believing any test of a refusal, check which refusal it is actually observing.**
    Third instance of ruling 58's family in this task alone, and the first one found by the author
    rather than a reviewer.

67. **The redacting logger is a value-shape net, not a field-name denylist — so a log binding
    named `body` is NOT safe.** Measured twice, and the second measurement corrected the first:
    `SECRET_KEY_FRAGMENTS` in `packages/observability/src/redaction.ts` lists `password`, `token`,
    `cookie`, `authorization` and the rest, and **neither `body` nor `text` is on it**.
    `redact({ body: '<a notice body>' })` returns it **verbatim**;
    `redact({ body: '…?token=…' })` returns `[redacted]` only because the VALUE matched a secret
    pattern. So the three templates carrying a link are rescued by their own link, and the five
    link-free notices are not rescued at all — logging one under any key emits it in full, against
    `CLAUDE.md`'s rule 6. **The assertion that holds "this call logs no body" is an exact key set**,
    because a new binding changes the keys whether or not its value survives redaction.

    *The Task 8 fix round asserted the opposite — that the two field names were blanked outright —
    and propagated it into this ruling, `roadmap.md`, `fixes.md` and a code comment before a scoped
    review measured it false. Four places from one unverified sentence, which is the propagation
    path behind five of Phase 1's twelve.*

68. **The resend endpoint is enumeration-resistant in its body and not in its timing.** Measured
    over 25 samples: no account 4.0 ms, already verified 4.2 ms, awaiting confirmation 8.6 ms, with
    non-overlapping ranges — a response over roughly 7 ms identifies the case. The three responses
    are byte-identical, which is what the contract requires. **Binds Task 10**, whose password-reset
    endpoint has the same shape and the same three cases, and it is not closable without the
    Phase 4 queue: the difference is a real send happening inside the request.

69. **`ApiDoc` can describe a request body as of Task 8, and every route with a body must.** M8.
    The field did not exist until now because Phase 1 shipped only `GET` probes, so the first three
    `POST` routes published nothing about what to send. **Binds every later endpoint task**: pass
    the same contract schema the `ZodValidationPipe` parses with, never a copy, so `.strict()`
    reaches the document as `additionalProperties: false` and a client can see that an unknown
    field is a 400 rather than a silently dropped value.

70. **A message sent to an address whose ownership has not been proven must render NO stored
    display name.** F1, and it is the H1 finding reopened through a second channel after the first
    was closed. `User.name` is free text up to 200 characters written straight from the registration
    body, and **an attacker seeds a victim's name by registering the victim's address first** — the
    address then exists, so the next registration attempt mails `registrationAttempt` to the victim
    greeting them with the attacker's sentence and URL, under a footer promising the message carries
    no link. Step 1 alone already mails the victim a branded verification message carrying that text.
    Closed the same way H1 was: `emailVerification` and `registrationAttempt` take no name, no IP and
    no user agent, so no parameter exists for the value to travel through.

    **Binds Task 10.** `passwordReset` still renders `recipientName`, its endpoint is unauthenticated,
    and it targets an address by exactly the same reasoning — so a reset message to an
    attacker-seeded, never-verified account carries the same injection **plus a live reset link**.
    Task 10 owns deciding whether the name is rendered only for a verified account or dropped
    outright. **Binds Task 15** for the invitation and any later template: the test to write is "no
    link when EVERY caller-supplied field is a URL", with the display name in the list.

    **"The invitation, which already names nobody" was false when this was written, and it stayed
    false for two tasks.** `renderInvitation` rendered `inviterName` — a stored `User.name` — into
    the **text** part of a message carrying a live token link, which is the worst shape this defect
    has taken. Neither ruling-70 test block ever ran a hostile payload at it: the whole-registry
    block passed only the *recipient's* name as hostile, and the fully hostile block ran over the
    notices, of which the invitation is not one. Found by Task 10's reviewer as the fifth channel
    and closed structurally; the clause is corrected here because a false clause in a ruling is
    what tells the next implementer not to look.

    **And the meta-lesson, which is worth more than the fix.** The round that closed H1 wrote this
    exact test, watched it go red on the display name, and **reasoned it into silence** with a
    sentence that was true about the data flow and false as an inference. A red test that a fix
    round turns off needs a second pair of eyes, not a comment.

### From Task 9

Full reasoning and cost-if-wrong for each is in [`task-09/review.md`](task-09/review.md),
[`task-09/fixes.md`](task-09/fixes.md) and [`task-09/fix-review.md`](task-09/fix-review.md).

71. **RULING 63'S CARVE-OUT IS WITHDRAWN. No notice renders a user agent — there is no field for
    one on any notice context.** Ruling 63 licensed a device string on four templates "because
    there it describes the recipient's *own* session", and marked itself *binds every later
    notice*. That exception produced the same defect three times in three tasks: Task 8's H1 (the
    `User-Agent` in `registrationAttempt`), Task 8's F1 (the display name), and Task 9's H2 — the
    unfamiliar-sign-in notice, where the notice fires **because** a stranger signed in, so the
    recipient and the chooser are different people in exactly the case the message exists for. The
    rendered proof is in `review.md`: a `Device:` line carrying
    `https://sentinel-verify.evil.example/login` under a footer promising the message contains no
    link. **A rule whose exception has produced three findings is not a rule with an exception.**
    What remains renderable is the time and the IP, and the IP is held to an address shape by
    `renderableIpAddress` — see ruling 72.

72. **"This value cannot carry a URL" is a claim about a SOURCE; a guard is a check on a SHAPE, and
    the two are not the same set.** The H2 disposition kept the IP line on the grounds that a
    socket peer address "cannot carry a URL, and is bounded and validated already" — true of
    `request.ip`, untrue of everything between it and the rendered line, and the fix round found
    ruling 70's widened test still red on four notices with `ipAddress` as the carrier. The first
    guard then admitted `facade.de`, `abcdef.cc` and `dead.beef.cafe` — hostnames under real TLDs
    that mail clients autolink from a bare domain, invisible to a suite asserting `https?://`
    (N-4). It is now two shape arms: a dotted quad, or something containing a colon. **Enforce the
    claim where the value is rendered, not where you believe it came from.**

73. **Every write on the login path is decided from a row read BEFORE a ~40 ms hash, so every one
    of them is conditional.** H1: `failedLoginCount + 1` computed from the pre-flight read and
    written as an absolute value meant five parallel wrong passwords left the counter at **1**, no
    lock, no `ACCOUNT_LOCKED` row, no burst notice, and a correct password afterwards answering
    200. The fix is an atomic increment plus a not-locked predicate — and the predicate is what
    makes "once per lock" true, not a refinement of it: with the increment alone, four siblings
    that all read 4 all wrote 5, all locked and all sent. The **success** path had the same defect
    one arm over (fix review's caveat): clearing `lockedUntil` from a stale decision *erased* a lock
    a sibling had just committed. §7's "an attempt during a live lock changes no state" says
    attempt, not failed attempt. **Binds Tasks 10, 11 and 14**, whose password change, MFA and
    membership writes all read a row, do slow work, then write.

74. **A sequential test cannot see a concurrency defect, and every lockout test in both lanes was
    sequential.** 1,120 unit and 230 integration tests were green over a control that did not
    engage. The probe that found it is five `POST /auth/login` in one `Promise.all`. **If a
    property is about two requests, the test has to be two requests.**

75. **The integration harness connects as the schema owner, so RLS is not enforced under it.**
    M1: replacing `withTenantTransaction(…)` with a direct client call — the exact code the
    docblock said returns `null` in production — left **both lanes green**, because
    `auth-harness.ts` overrides `PRISMA` with a client bound to `postgres.ownerUrl`. Any spec
    asserting a property that only RLS provides must drive the **least-privileged** role
    explicitly, or it is asserting that Postgres has policies rather than that this code obeys
    them. **Binds Task 12 hardest**, which is where tenant isolation becomes the product.

76. **A message nothing reads is a message anyone can rewrite.** L5: the refusal for a locked
    account told a permanently disabled user three false things ("temporarily", "try again later",
    "reset your password"), and when the reviewer reverted the corrected message **both lanes
    stayed green** — no test observed the string. One code and one message for both kinds of lock
    is right; buying non-disclosure by telling the legitimate user something untrue is not. The
    string is now pinned by a spec, and the mutation re-run to prove the pin bites.

77. **An enumeration byte-comparison over an ERROR envelope is not Task 8's comparison.** Task 8
    compared 200 bodies that are one constant literal; login's refusals carry a per-request
    `requestId`, so the comparison substitutes it exactly as the CSP nonce is already substituted,
    and `code`, `message`, `details` and `timestamp` stay in. **Binds Task 10**, whose reset
    endpoints have the same shape.

78. **The burst notice's send happens inside the request, and that is ruling 68's oracle on a new
    endpoint** (M3, accepted not fixed). The fifth wrong password against a real address pays an
    SMTP round trip the fifth against an unknown address does not. **Not closable before the Phase
    4 queue** — the difference is a real send inside the request — and materially weaker than
    ruling 68's, because reaching it costs five failed attempts against one address. Named in
    `security/authentication.md` §2 and §7 rather than left for a later reader to rediscover.

79. **The account lock is a bound, not a prohibition, and the documents said otherwise** (L7). One
    address trips four locks per 15-minute window and can hold roughly **eight accounts locked
    indefinitely**. §7's "independent per-IP limits so one attacker cannot lock out a whole tenant"
    describes expense, not impossibility, and what the integration lane actually asserts is that
    the two windows are independent. A control described as stronger than it is will not be
    re-examined by the person who most needs to.

80. **`ACCOUNT_LOCKED` is returned only when the password was otherwise correct.** Answering it to
    any attempt on a locked account would hand an existence oracle to precisely the caller who has
    just proved they will make five attempts. Wrong password on a locked account is
    `INVALID_CREDENTIALS`, byte-identical to every other failure. The 403 is
    `api/authentication.md` §6's, not 401.

81. **The pending-MFA credential shipped provisional and ADR-0018 is still owed by Task 11.** Login
    refuses to issue an `ACTIVE` session when a confirmed `MfaFactor` exists — the refusal half is
    real, so Task 11 does not land on a latent bypass — and returns a `PENDING_MFA` session token
    in the body with no cookie. It is unreachable by any shipped route (the guard reads the cookie
    and `@AllowPendingMfa` sits on no handler), and `loginResponseSchema`'s committed shape lets
    Task 11 change the delivery without a breaking wire change.

### From Task 10

Full reasoning in [`task-10/review.md`](task-10/review.md),
[`task-10/fixes.md`](task-10/fixes.md) and [`task-10/fix-review.md`](task-10/fix-review.md).

82. **A session must be issued conditionally on the credential it was authenticated with, and
    writing the hash before revoking is NOT enough.** H1, and it corrects ruling 51. A login whose
    credential read preceded a reset's commit and whose `Session` insert follows the reset's revoke
    is never swept — `updateMany` cannot revoke a row that does not exist yet. Measured at **25 of
    25** survivors across five rounds, each a fully privileged `ACTIVE` session answering
    `GET /auth/session` with 200 for up to 30 days, on the endpoint whose entire purpose is evicting
    somebody who knows the old password. The window is **one Argon2id verification wide and grows
    with the security parameter** — ~250 ms in production against ~40 ms in the harness. Closed by
    re-reading the credential *after* `issue` and revoking the session just made: either the insert
    precedes the revoke and is swept, or it follows and the re-read observes the new hash. There is
    no third ordering. **Binds Task 14**, whose member removal has the same shape and no equivalent
    check, and any later path that issues a credential-derived session.

83. **The check must compare MEANING, not bytes.** The naive form revokes whenever the row changed
    for any reason, and the transparent rehash gives it two innocent ones. A mismatch is the
    question, not the answer: re-verify the submitted password against what is stored now. Deleting
    that fallback refused **3 of 4** concurrent correct-password sign-ins for the duration of a
    parameter migration — with the whole suite green, because the only rehash test was
    single-threaded. **An availability property has no advocate unless a test holds it.**

84. **A control read inside a READ COMMITTED transaction is not serialised by the transaction.**
    NEW-3: the burst notice counted denials inside the transaction that wrote one, so parallel
    denials each counted the threshold and each sent — 2 and 3 notices for one burst in two rounds
    of four. Every test of it was sequential. This is **ruling 74 recurring inside the fix round for
    a finding whose own dispositions cite ruling 74**. Closed with a per-account
    `pg_advisory_xact_lock`, the mechanism `TokenService.issue` already uses: READ COMMITTED takes a
    fresh snapshot per statement, so a transaction that waits sees what it waited for.

85. **Ruling 70 is CLOSED for the recipient's display name, and the fifth channel is why it took
    three tasks.** No template accepts a `recipientName`; the typecheck is the control and the
    two-sided residual test was deleted rather than adjusted. The channel that survived two previous
    closures was `invitation`'s **inviterName** — a different person's stored name, in the text part
    of a message carrying a live token link — invisible because the whole-registry payload only made
    the *recipient's* name hostile and the fully hostile payload ran over notices only. **A test that
    covers "every template" over the wrong field is not coverage.**

86. **The sixth channel is `organizationName`, and it is characterised rather than closed.** SMTP
    header injection is shut at two layers. The CR/LF half was closed in Task 10 — the value could
    otherwise forge whole paragraphs above the product's live link, which is a different primitive
    from one autolinked URL. What remains: a bare URL still autolinks in the text part, and
    **`Organization.name` has no length cap in `schema.prisma` or in any Zod schema**. **Binds Task
    13**, and "reject URLs" is not sufficient on its own.

87. **A concurrent test can still be vacuous.** The first parallel change-password probe used two
    sessions, so the winner revoked the loser's session and the loser was refused by the
    authentication guard before it ever reached the predicate under test — deleting the
    compare-and-swap left it green. Ruling 74 sharpened: **making a test concurrent is not enough;
    the two requests must differ only in the property under test.**

88. **Some concurrency kills are distributions, not determinisms, and the honest move is to say so
    in the docblock.** The reset's credential predicate is genuinely reachable — 3 of 20 rounds with
    a real competing writer, 0 of 20 with it deleted — but the window is one statement wide, so an
    assertion on the count would be flaky at roughly one run in twenty-five. The committed probe
    asserts what holds every round and its docblock states plainly that deleting the predicate does
    **not** turn it red. Recorded as an accepted limit rather than as coverage. (M1, judged
    acceptable by the fix round's reviewer.)

89. **A reset for an account with no `Credential` row SETS a password, which is right today and is a
    Phase 11 SSO bypass.** It keeps SSO-only accounts from being permanently stranded. Once
    `IdentityProviderLink` accounts exist, a reset link would mint password access to an account
    whose owner never had one. Recorded at the site and in `security/authentication.md` §6; **binds
    Phase 11.** Deliberately not fixed in Task 10, which cannot make a Phase 11 decision.

90. **`change-password` is a weaker guard on the password than `login` is, by construction.** It
    verifies a password while requiring only a stolen session, and it is deliberately outside the
    lockout ladder — `ACCOUNT_LOCKED` there would be a distinguishable outcome and would let a
    session thief lock the owner out. What it has instead is a per-IP limit and, since the fix round,
    a burst notice to the owner. **The per-account 429 that would actually bound it needs the
    limiter's per-principal stage, owed since ruling 55.**

## Pause state

**2026-09-02 — Task 11 complete, reviewed and fixed; Task 12 is next. Checkpoint A is one task
away, and it is the last one before this phase gets a recorded status.**

Task 11 shipped **TOTP MFA and recovery codes**. `pnpm check:openapi` reports **18** routes, up from
13. A person can enrol an authenticator, confirm it, complete a second factor at login, spend a
recovery code, regenerate the set, and turn MFA off — three of those requiring the current password.

**The migration is applied.** `20260901185059_mfa_factor_last_accepted_step` was generated with
`--create-only` per the plan's §5, reviewed by the operator on 2026-09-02, and applied then —
`_prisma_migrations` ends there and `MfaFactor.lastAcceptedStep` exists as `integer`. No drift, no
working-tree change. The SQL is quoted in full in [task-11/report.md](task-11/report.md).

**The High was H1 and it was measured.** Two concurrent regenerations left twenty live recovery
codes from two `200 OK` responses, and the consumer's unordered `take: 10` made ten of the twenty
the owner was shown permanently unusable. Concurrent enrolment answered 500. Both closed by a
per-user `pg_advisory_xact_lock` — the device this module already used one file over, keyed on the
pending session instead of the user.

**Ruling 88 fired twice, and the second time was on the fix itself.** H1's guard, written as one
race, reproduced the defect in only two runs out of three against the unlocked code. Rewritten to
five rounds asserting the invariant after each round, it is 3 of 3. A guard that misses a High one
time in three is a guard that goes green on the regression that reintroduces it — measure the guard,
not just the fix.

**Eight false sentences, three inside security controls**, and the two worth carrying: a rate-limit
comment and `abuse-prevention.md` §1 both said "one expected success every 630 years" where the
same premises give **0.63 years**; and `security/authentication.md` §5 marked incremental MFA key
rotation **Built** when the process holds one key and rotating it would make every enrolled factor
undecryptable *silently*, because `mfa/verify` answers the ordinary `MFA_INVALID`. One false
sentence originated in the orchestrator's brief and reached two committed artefacts; one was
introduced by the orchestrator's own re-verification **in the same commit that falsified it**.

**Task 12 inherits.** `Organization.requireMfa`'s guard is written and **registered in no module** —
Task 12 places it in the pipeline, and a spec that strips comments before searching asserts it is
absent today. `MFA_ENROLMENT_REQUIRED` has no producer. `@RequirePermission()` is still metadata no
guard enforces, which is Task 12's whole subject.

**Still owed, and none of it Task 11's to close:** the promoted session takes the ordinary 7-day
lifetime even when "remember me" was ticked (login discards `rememberMe` on the pending arm and
`rotate` inherits the row's value — needs a `Session` column or a `rotate` parameter); incremental
MFA key rotation, which is an ADR nobody owns; ruling 55's per-principal limiter stage; per-account
notice throttling (ruling 79); the racing-login equivalent for member removal (ruling 82, Task 14);
`Organization.name`'s absent length cap (ruling 86, Task 13); and ruling 24's dormant-account
rehash half.

**Branching. Task 11 is merged.** PR #21, rebased onto `main` on 2026-09-02 and the branch
deleted, with CI green on a Linux runner before the merge — runs `33587016061` (branch head) and
`33587041645` (pull request), both `success` at ~5m, with every stage confirmed to have executed
rather than inferred from the conclusion. The `Failed to connect to Reaper` flake that hit PR #19
did not recur, which does not mean it is fixed — it is a Ryuk startup failure on the runner and it
will come back. **Task 12 branches from whatever `main` is when you start** — pull first; do not cut
from a commit named in this file.

**The fix round has not itself been reviewed.** Every change in it was measured with the mutation
re-run and pasted, but that is the author checking their own work — the same status Task 10's last
three commits carried into Task 11, where its reviewer was told it could treat them as unexamined.

**Next action:** Task 12 — tenant resolution and the authorization guard, which the plan puts in
the **orchestrator** column rather than a subagent's, because it is where the security model becomes
real. Fold commit `7540279` — Task 11's unreviewed fix round — into that task's review, the way Task
11's reviewer was handed Task 10's unexamined commits.
