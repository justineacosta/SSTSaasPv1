# Phase 2 · Task 4 — rulings

> **A dated record of what was said and decided at the time. Not a description of current state —
> [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

Dated 2026-08-26. Written by the orchestrator. Ten rulings were taken **before** dispatch and are
in [`brief.md`](brief.md); this file records how the review's findings were dispositioned and the
decisions taken during the fix round. Each carries the cost if it is wrong.

## Disposition of the review's findings

| # | Finding | Disposition |
|---|---|---|
| H1 | Two concurrent `issue` calls leave two live tokens | **Fixed** — `7aff3cf` |
| M1 | Four commits fail `check:openapi`; the contract change hid in a `docs(ledger):` commit | **Fixed** — history rewritten |
| M2 | The redaction pattern blanks whole fields on `?key=`, `?code=`, `?signature=` | **Fixed** — `77de261` |
| M3 | `@sentinel/db/testing` is an unfenced route to the schema-owner DSN | **Fixed** — `77de261` |
| L1 | `X-Amz-Signature` is not covered by the pattern's anchoring | **Recorded**, ruling 36 |
| L2 | Residual leak shapes: path-segment token, percent-encoded URL | **Recorded**, ruling 36 |
| L3 | The flake is broader than the report said; a concrete lead | **Fixed** — `06dd203`, ruling 33 |
| L4 | `consume` performs no `User.status` check | **Recorded**, ruling 37 |
| L5 | `SECRET_TOKEN_TTL_SECONDS` sits in the DI-token file | **Accepted as built**, ruling 38 |

Both deviations the implementer flagged were judged by the reviewer and I agree with both: not
editing `monitoring.md` §2 was right (the fix changed no key name, and §2 does not enumerate
value-shape heuristics), and moving the `userId` lookup *after* the winning update is better than
the brief's permitted hint, because a stale read then cannot structurally become the decision.
**A brief's ruling is a floor, not a ceiling.**

## Ruling 31 — H1 is fixed with an advisory transaction lock, not a partial unique index

The review proved that `issue`'s supersede-then-insert does not hold under concurrency: under
READ COMMITTED a second transaction's `UPDATE … WHERE consumedAt IS NULL` cannot see the first's
uncommitted `INSERT`. Reproduced independently before fixing, ten rounds of two parallel calls:
`[2,2,2,2,2,2,2,2,2,2]` live tokens where §6 promises one.

`pg_advisory_xact_lock(hashtext('vtk:<userId>:<purpose>'))` as the first statement in the
transaction. Chosen over `SELECT … FOR UPDATE` on the `User` row because a row lock there would
contend with every ordinary write to that user — starting with the `lastLoginAt` Task 9 is about
to add — and over `SERIALIZABLE` because that turns the loser into a 40001 the caller must retry.

**Cost if wrong.** `hashtext` collisions make two unrelated users serialise their token issuance
for the few milliseconds the transaction lasts; that is the whole downside. The lock is released
by commit or rollback, so there is no unlock path to forget. What it does **not** give is a
database-level guarantee: a future caller that writes `VerificationToken` without going through
`issue` is not covered. See ruling 32.

## Ruling 32 — the partial unique index is owed, not skipped

`(userId, purpose) WHERE consumedAt IS NULL` would make the invariant the database's rather than
this method's, which is what `CLAUDE.md`'s "database integrity belongs in the database" asks for.
It is deliberately **not** in Task 4: it needs a hand-written migration (Prisma can neither create
nor drop a partial index — Task 1, carry-forward ruling 4), and it changes the contract of `issue`
by turning a race's loser into a P2002 the caller must catch and retry.

**Cost if wrong:** the application-level lock is the only thing holding §6's supersession
invariant, so a second writer that bypasses `TokenService` reintroduces H1 silently. **The task
that opens the next migration owns adding it** — Task 11 is the first with one in view.

## Ruling 33 — the intermittent integration suite was two latent defects, and both are fixed here

Neither is Task 4's code. Task 4 is implicated only because a twelfth integration file changed the
scheduling enough to make the overlap frequent.

1. **`fileParallelism: false` had never been in force.** Vitest resolves the pool's worker count
   from the **root** config; `vitest.workspace.ts` declares projects only. Measured: a default
   `pnpm test:integration` reported **140.60s of test time inside a 19.72s wall clock**.
2. **`rate-limit.integration.spec.ts`'s `beforeEach` deletes `ratelimit:login:*`**, which is
   exactly the namespace `sliding-window.integration.spec.ts` builds its keys in. Its comment
   claimed the narrowing "protects other suites". It did not.

Fixed by passing `--no-file-parallelism` in the root script, and by correcting the false comment.
Five consecutive green runs afterwards, against roughly one failure in two before.

**Cost if wrong:** the integration suite is now ~57–67s instead of ~20s. That is the price of the
isolation the config always claimed to provide, and it is paid once per run rather than in
sessions spent re-diagnosing a flake. The residual is that sequential execution is the **only**
guard: restore parallelism and the deletion reaches across files again.

## Ruling 34 — `key` and `code` leave the redaction pattern; the link format bends to it instead

In `redact()` a value-pattern match replaces the **entire** field, so `?key=` would blank whole
URLs — and object keys are what this product's entire evidence subsystem is addressed by. `?code=`
matches this repository's own SCREAMING_SNAKE error codes, all of which clear the eight-character
floor. Both removed; `signature` kept.

Removing `code` broke an existing fixture that used `&code=` for an invitation link, and the
fixture was retargeted to `&token=` rather than the pattern being widened back. **That is the
ruling, and it binds Tasks 5 and 15:** a link that carries its secret under a parameter name
outside this pattern reaches the logs intact. Use `token`.

**Cost if wrong:** an OAuth authorization code in a query string would not be redacted. Nothing
issues one today; Phase 11's SSO work owns re-adding `code` with a shape that excludes an all-caps
error name.

## Ruling 35 — `@sentinel/db/testing` is fenced by lint, and the export stays

The export is the right answer to the brief's Ruling 10 — the harness is how an `apps/api`
integration spec reaches a **migrated** database, which the compose stack is not in CI. What was
wrong is that it arrived unfenced: a non-spec probe importing `startPostgresHarness` passed both
`eslint` and `tsc`. It now fails lint, proven by running it, and `coding-standards.md` §6 records
the rule beside the two it sits with.

**Cost if wrong:** the fence is a lint rule, so anything outside ESLint's reach still resolves the
import. It is the same class of guard as the two either side of it, and no weaker.

## Ruling 36 — the redaction residuals are recorded, not closed

Measured by the reviewer and left as they are: a token in a **path segment** (`/verify/<token>`)
leaks, a percent-encoded URL nested inside another URL leaks, `?t=<token>` leaks, and
`X-Amz-Signature=` is not matched because the pattern anchors on `[?&#]` immediately before the
name. **Binds Task 5, which owns the link format:** build the link as `?token=<value>` on a query
string. A path-segment link is not covered by any redaction this repository has.

## Ruling 37 — `consume` returns a `userId` and asserts nothing about that user

`User.status` exists and a `LOCKED` or suspended user's tokens still redeem, because the FK
cascade only removes a **deleted** user's rows. Correct as designed — status is the endpoint's
business — but carry-forward ruling 9 already records that `VerificationToken` has no RLS behind
it, so nothing in the database catches it either. **Tasks 8, 10 and 15 must re-resolve the user
and check `User.status` after `consume` returns.**

## Ruling 38 — `SECRET_TOKEN_TTL_SECONDS` stays in `auth.tokens.ts`

The brief said not to put secret-token constants in the DI-token file. What went in is a DI key
string, which is the only kind of thing that file holds, and its docblock now states the two
senses of "token" explicitly. Accepted on the merits.

**Cost if wrong:** the `SECRET_TOKEN_` prefix the brief chose to mean "credential" now also
appears in the file that means "DI key", so the prefix no longer disambiguates on its own. The
docblock carries that weight instead.

## Ruling 39 — the branch history was rewritten so `check:openapi` is green at every commit

`apps/api/openapi.json` gained `"TOKEN_INVALID"` four commits after `packages/contracts` did, and
it landed inside a commit typed `docs(ledger):` — the one commit a reviewer skips, carrying a
change to the **shipped API contract**. Since PRs on this branch are rebase-merged, those four
commits would have entered `main`'s history with `pnpm check:openapi` exiting 1.

The five commits were replayed with the regenerated document folded into the contracts commit.
The resulting tree is **byte-identical** to the pre-rewrite tree (`git diff --stat` empty against
the backup branch), and the full suite was re-run on the rewritten history.

**Cost if wrong:** a history rewrite can lose work. It was done on an unpushed branch behind a
backup branch, the trees were diffed before the backup was deleted, and every command was re-run
afterwards. The alternative — leaving it — costs `git bisect` over `check:openapi` and puts a
contract change where nobody looks.

## Ruling 40 — the reviewer left a mutated Prisma client behind, and two guards caught it

The review's mutation experiments added `MUTANT_PURPOSE` to `VerificationPurpose`, regenerated the
client, then reverted `schema.prisma` **without regenerating**. `git status` was clean, because
`packages/db/generated/` is not tracked. `enum-parity.spec.ts`'s staleness assertion failed with
`schema-mismatch`, which is exactly what it exists for, and `check:registry` refuses a stale client
for the same reason.

**This is recorded as a success, not a complaint.** It is the second time a guard has caught a
regenerate-forgotten mutation on this project. **Any agent mutating `schema.prisma` must run
`prisma generate` after reverting**, and a clean `git status` is not evidence that it did.
