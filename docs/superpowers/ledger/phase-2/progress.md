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
    member removal must write the membership change first. Otherwise a racing login mints a session
    with the old credential once the revocation has finished.

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

67. **The redacting serialiser blanks `body` and `text` by field NAME, not by value pattern.**
    Measured: adding the rendered email to a log call emits `"body":"[redacted]"`, so no
    value-based assertion can fail on it. That makes the denylist a real second line of defence —
    and it is only the second. A binding named anything outside that list carries the value
    straight through. **The assertion that holds "this call logs no body" is an exact key set**,
    because a new binding changes the keys whether or not its value survives redaction.

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

## Pause state

**2026-08-31 — Task 8 complete and verified; Task 9 is next. Checkpoint A is four tasks away.**

Task 8 shipped **the first three routes this product has ever published**. `pnpm check:openapi`
reports **7**, not 4, and every sentence in this ledger that cited 4 as the proof that no endpoint
shipped now applies only to the dated table it sits in. A person can register an account and confirm
an email address. **Nothing authenticates anybody yet** — there is no login endpoint until Task 9,
and no screen until Task 16.

**ADR-0019 was written and committed before any implementation**, as 0014–0017 were, and it decides
where an audit event goes when the actor belongs to no organisation. The claim it rests on was
measured rather than reasoned, and the reviewer reproduced it independently. **0018 stays reserved
for Task 11.**

**One High, and it was live behaviour rather than a missing test.** An unauthenticated caller could
inject 512 characters of chosen text, a URL included, into a security notice mailed to any address
they could guess was registered — under a footer promising the message carries no link. Fixed with a
type that cannot carry the value rather than a filter. The spec that should have caught it ran the
benign fixture, which is ruling 58's third instance in three tasks.

**Read this before trusting the fix round: the implementer subagent hit the weekly usage limit after
landing the High fix, and the orchestrator finished the remaining seventeen findings directly.**
Nothing in that round has been adversarially reviewed. Every fix is proved by re-applying the
reviewer's own mutation and pasting what went red, and the round found two defects in its own fixes
by doing so — but the separation of author from reviewer that the rest of this phase depends on is
absent for it. **Task 9's reviewer should treat Task 8's fix commits as unreviewed code**, in
particular `auth.controller.spec.ts`, `request-context.spec.ts`, `auth-mailer.spec.ts`, the
`redeemableUserId` control added to `identity-fakes.ts`, and the `requestBody` support added to the
OpenAPI generator.

**One finding is upheld as false and deliberately not fixed** — ruling 65, a comment inside an
applied migration that cannot be corrected without costing the operator a database reset an agent
cannot perform.

**Two local facts corrected from Task 7's pause state.** Tasks 6 and 7 **are** on `main` with CI
green (runs `33088717123` and `33088206506`); the "unpushed with no pull request" sentences were
stale. And the compose Postgres privilege drift **has cleared** —
`has_schema_privilege('sentinel_app','public','USAGE')` returns `t` where Task 7 measured `f` twice
— which is what let this task's integration suite drive the endpoints end to end.

**Branching. Task 8 is on `feat/phase-2-task-08`, cut from `main` at `a39f4b3`, unpushed, with no
pull request** — one task of work, not two. The operator decides when it is pushed.

**Next action:** Task 9 — login, logout, the session endpoint and lockout, chained with Task 10
(password reset). One implementer across both, reviewer fresh per task.

Task 9 inherits more than any task so far. **Rulings 24, 25, 50 and 56**: the timing oracle that
opens the day an operator raises the Argon2 parameters, the silently-corrupted-credential signal
with no log line, the requirement that a `PENDING_MFA` → `ACTIVE` rotation carry its
`mfaCompletedAt`, and **login CSRF, which Task 7 deliberately did not cover** — a cross-site login
`POST` carries no session cookie, so double-submit has nothing to bind to, and Task 9 brings its own
mechanism. **Ruling 18**: `loginRequestSchema` has no `rememberMe` and Task 9 adds it. **Ruling 62**:
a login event has no organisation, so it is a `PlatformAuditEvent`. **Ruling 64**: assert the
rate-limit class on the handler. **Ruling 69**: declare the request body. **Ruling 49**: pin one side
of an expiry assertion to a fixed instant.

And the one Task 8 could not discharge: **no audit event is written for a failed verification**,
because the refusal rolls back the transaction the event would live in. `audit.md` §3 says failures
and denials are audited. **Task 9 meets this harder and owns solving it**, because a failed login is
the single most important failure event in the taxonomy.
