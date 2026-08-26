# Phase 2 · Task 5 — rulings

> **A dated record of what was said and decided at the time. Not a description of current state —
> [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

Dated 2026-08-26. Written by the orchestrator. Twelve rulings (41–52) were taken **before**
dispatch and are in [`brief.md`](brief.md); this file records how the review's findings were
dispositioned and the decisions taken during the fix round. Each carries the cost if it is wrong.

## Disposition of the review's findings

| #  | Finding                                                          | Disposition                          |
| -- | ---------------------------------------------------------------- | ------------------------------------ |
| H1 | The recipient guard stops CR/LF/NUL but not a comma               | **Fixed** — `0f464e8`, ruling 53     |
| M1 | A token quoted by a relay without its `?token=` prefix reaches `err.message` | **Recorded**, ruling 58   |
| M2 | The subject sanitiser exists only in `renderEmail`, not at the port | **Fixed** — `25be947`, ruling 54   |
| M3 | The transport-reuse comment claims pooling that is not configured | **Fixed** — `50b8d01`, ruling 55     |
| M4 | The "seventh template, Task 15's" narrative is wrong              | **Fixed** — `2c3410c`, ruling 56     |
| L1 | `WEB_BASE_URL` accepts a `javascript:` scheme and reaches an `href` | **Fixed** — `9d4b93f`, ruling 59   |
| L2 | `EmailAction.url` is unvalidated in an `href` sink                | **Fixed** — `bddea17`, ruling 59     |
| L3 | A live-format 256-bit token is committed in `report.md`           | **Fixed** — `0088852`, ruling 57     |
| L4 | `report.md` §5's literal sentence is false                        | **Fixed** — `0088852`                |
| L5 | `escapeHtml` is adequate for quoted attributes only               | **Accepted as built**, ruling 60     |

**The review's Pass 1 found two false sentences in the implementer's report and confirmed every
command, exit code, file line count and commit SHA in it reproduced exactly.** It also verified,
unprompted, that the reviewer's own two orchestrator-supplied premises held: ADR-0016 at
`09:28:54` precedes the brief at `09:32:12`, which precedes the first implementation commit at
`09:38:20`, and the brief has exactly one commit and was never amended. That is the citation pass
working as designed for the third task running.

Both deviations the implementer flagged and the two additions it made unprompted were judged on
their merits. **Addition A2 — the recipient guard — is the one that produced this task's High**,
and that is worth stating plainly rather than treating as an argument against volunteering
controls: a guard that half-holds is still better than the absent guard it replaced, and it was
the guard's own existence that gave the reviewer something specific to attack.

## Ruling 53 — the recipient guard enforces **one address**, not the absence of a line break

`FORBIDDEN_IN_ADDRESS` matched CR, LF and NUL. nodemailer parses `to` as a comma-separated address
**list** and issues one `RCPT TO` per entry, measured twice — against a local capture server
(`RCPT TO:<a@b.test> | RCPT TO:<attacker@evil.test>` from a single `send`) and against the real
compose Mailpit, where the attacker address received the message. The same probe established the
guard is the **only** line of defence: given a CRLF recipient directly, nodemailer did not refuse
it and delivered to the injected address instead of the intended one.

The guard now refuses a comma, a semicolon, angle brackets, any whitespace, and anything with other
than exactly one `@`, in addition to CR/LF/NUL. Deliberately conservative rather than RFC 5322
complete: this is the second line, and Zod's `.email()` at the HTTP boundary is the first.

**Cost if wrong.** A conservative rule refuses a legitimate but exotic address — a quoted local
part, or one containing a comma inside quotes. Nobody has such an address in this product today,
registration will validate with Zod before reaching here, and the failure mode is a refused send
that raises loudly rather than a credential delivered to a stranger. If it ever bites, the fix is
to widen the rule against a real address, not to remove it.

## Ruling 54 — the subject is sanitised at the port as well as in `renderEmail`

`sanitizeSubject` ran only inside `renderEmail`. `OutgoingMail`'s type permits a caller to
construct a message without going through the layout, and the port's own docblock invites exactly
that by listing `subject` as a plain field. No injection was achieved — nodemailer's MIME encoder
folded a CRLF subject and no `Bcc` header appeared in the captured DATA — so this was a
consistency defect, not a live hole.

It is fixed because the implementer's own two arguments demanded it: deviation D2 duplicated the
credential-pair check into `toTransportOptions` because "a control that lives only in the schema is
a control the next caller bypasses", and addition A1 justified the sanitiser as a second line
because "a control that exists only inside a dependency is a control that changes when the
dependency does". Both apply verbatim to the subject at the adapter.

**Cost if wrong:** the sanitisation runs twice on every rendered email. It is a scan over a short
string, and idempotent.

## Ruling 55 — the pooling rationale is corrected; pooling is **not** turned on

`smtp-mailer.ts` said the transport is built once because "a transport per message would open a TCP
connection per email and discard whatever pooling the relay offers". `pool` is never set anywhere
in this change, and nodemailer selects its pooling transport only under `if (options.pool)`.
Measured: three sends on one `SmtpMailer`, three TCP connections, none left open.

**The comment was corrected rather than the behaviour changed.** Enabling `pool` alters runtime
behaviour against a relay nobody has tested, and ADR-0016 already names connection tuning as
deferred — a fix that silently expands the change's blast radius to make a false comment true is
the wrong direction.

This is carry-forward ruling 22 recurring in a new place: **a decision can be right while the
reason written beside it is false, and the false reason is still a defect.** Building the transport
once is right — it is what makes ruling 49's boot-with-the-relay-down work, corroborated
independently by `CONNECTIONS_AFTER_CONSTRUCT=0`. Only the stated benefit was invented.

**Cost if wrong:** none to behaviour. The cost of *not* fixing it was a reader deciding whether
mail volume needs work while believing pooling was already in effect.

## Ruling 56 — there are **seven** templates, and the eighth is unowned

`EMAIL_TEMPLATES` has seven members and the invitation template — attributed in four docblocks, a
test title and the implementer's report to "Task 15's seventh template" — is member three, built in
Task 5. The next template added is the eighth and no task owns it.

The mechanism those docblocks describe is real, and the reviewer verified it destructively rather
than by reading: a deliberately broken extra template fired **eight** assertions naming every
planted defect, leaving it unclassified fired a ninth, and omitting it from `CASES` produced the
promised `TS2741`. Only the count and the attribution were wrong.

`report.md` keeps its original sentence, because a ledger is a dated record of what was said at the
time. **What mattered was keeping it out of `progress.md`'s carry-forward section**, which is the
path that produced five of Phase 1's twelve false-claim instances — a Task 15 brief would have
inherited it and sent a session looking for a template that already exists.

**Cost if wrong:** none; the count is checkable in one grep.

## Ruling 57 — the raw token leaves the ledger, and the history residual is the operator's call

A live-format 256-bit token was pasted verbatim into `report.md` §6, and the reviewer found the
corresponding message still sitting in Mailpit and confirmed the quote was byte-for-byte. The
review then quoted the same value twice while reporting it. All three occurrences are redacted.

It is inert in substance: minted for a Mailpit send, no `VerificationToken` row was ever written,
no account exists. It is fixed anyway because `CLAUDE.md` rule 6 says never log a token, a ledger
file is a file, and the reflex is the control — a product whose repository has carried a red
GitGuardian check on three of its four code pull requests does not need a genuine-looking secret
added to the pile.

**The history was rewritten, on the operator's decision, before the branch was pushed.** The value
survived the working-tree redaction in `0088852` at `aaa6d39` and `d5161c5`, and `main` blocks force
pushes and requires linear history — so the merge would have made it permanent. `git filter-branch
--tree-filter` replaced it across all 22 commits in the range, behind a backup branch, following
Task 4's precedent (carry-forward ruling 39): **the resulting tree is byte-identical to the
pre-rewrite tree** — both `4f1ff58eccfdf3fa825f5ccc769573ba230de79d`, with an empty
`git diff --stat` against the backup — and the full suite was re-run on the rewritten history
before the backup was deleted. `git log -S` over the range now returns no commit.

One consequence worth naming rather than hiding: **commit messages in this range still describe the
redaction as a working-tree fix**, because they were written before the rewrite was decided. They
are accurate about what that commit did and incomplete about what happened afterwards; this ruling
is the record that closes the gap.

**Cost if wrong:** a history rewrite can lose work. It was done on an unpushed branch behind a
backup, the trees were compared by hash before the backup was deleted, and all ten verification
commands were re-run afterwards. The alternative was an inert but genuine-shaped secret in `main`'s
permanent history and a likely fourth consecutive GitGuardian finding.

## Ruling 58 — the relay-error token residual is recorded, not closed

Ruling 47's spec exercises the failure path with a *synthetic* `new Error('ECONNREFUSED …')`, so it
proves the adapter adds no body content of its own and nothing more. The reviewer drove four real
failure paths through the real `SmtpMailer` and the real `createLogger` with a sentinel token.
Connection-refused and TLS-mismatch are clean. A relay rejecting with the token inside a `?token=`
URL — the realistic content-scanner shape — **is** redacted, in both the whole-field and span
forms. A relay quoting the token **stripped of its URL** leaks it verbatim into `err.message`,
`err.response` and `err.stack`.

This is precisely the residual carry-forward ruling 36 names and that `redaction.ts` documents in
its own comment. **It is not closed here, and the reason is carry-forward ruling 34:** `redact()`
blanks the whole field on a value-pattern match, which is why `key` and `code` had to be *removed*
from that pattern in Task 4. Widening it to catch a bare 43-character base64url run would blank
every field containing an object key, a hash, or an ID of similar shape — a much larger change than
this task, aimed at a hole in the backstop while the primary control (the adapter logging no body)
is intact.

**Cost if wrong:** a relay that echoes token material stripped of its URL puts a live single-use
credential in a log line. It needs that specific relay behaviour, and the credential is single-use
with a 1–24 hour TTL. **Owed by whichever task next touches `redaction.ts`**, and it belongs in the
same change as ruling 36's other residuals rather than being fixed alone.

## Ruling 59 — the URL scheme is constrained at the config layer and again at the render layer

`z.string().url()` delegates to `new URL()`, which accepts **any** scheme; `javascript:alert(1)`
and a `data:` URL both passed `WEB_BASE_URL` validation, `buildTokenLink` returned
`javascript:alert(1)?token=…`, and `escapeHtml` left it byte-identical on the way into an `href`.
`escapeHtml` is not a scheme check and was never meant to be — it touches neither `:` nor `(` nor
`)`.

Both layers, deliberately. `packages/config` now constrains `WEB_BASE_URL` and `API_BASE_URL` to
http/https **on both schemas** — `apps/web` boots on `webEnvSchema`, which declares its own copies
rather than sharing the API's, so fixing one alone is the half-applied control the review raised as
M2. And `renderEmail` refuses an action URL whose scheme is not http or https, which is the guard
for the next template that builds a URL some other way. The render-layer check sits in `renderEmail`
rather than in `actionHtml` because the action URL lands in the text part too, and a guard on the
HTML path is a guard that disappears the day someone renders only text.

**Two things this turned up that the review did not name.** A failed `.url()` check marks the
result **dirty**, not aborted, and Zod runs a `superRefine` over a dirty value — so an unguarded
`new URL()` inside the refinement threw a raw `TypeError` straight past `loadEnv`'s error envelope.
The existing spec asserting that no sentinel value ever reaches an error message caught it, which
is the second time this phase that a Phase 1 guard has caught a Phase 2 mistake. And `describeIssue`
rendered every `custom` issue as "failed validation (custom)", so it now reads an authored
`params.rule` — preserving its rule of never reading `issue.message`, only rule parameters this
repository authored, while letting the operator learn *why* a value was refused.

**Cost if wrong:** an operator with a legitimate non-http scheme for a base URL is refused at boot.
There is no such scheme. The value is operator-controlled rather than attacker-controlled, so this
was defence in depth and not a live hole — but Task 5 is the change that first turned a configured
URL into a link a user clicks, and that is when the schema's shape started to matter.

## Ruling 60 — `escapeHtml` is scoped to quoted attributes, and that scope is now load-bearing

Measured: the function leaves `/`, `=`, space, tab, newline, `(`, `{`, `;` and `:` untouched, so
`escapeHtml('x onload=alert(1)')` is unchanged and would break out of an **unquoted** attribute.
Every attribute in `layout.ts` is double-quoted with a constant `style` value, so nothing is
reachable, and the function's own docblock scopes itself honestly ("either an element body or a
double- or single-quoted attribute value"). Both quote characters *are* escaped, which is what
closes the attribute-breakout path for the quoted case.

Accepted as built. **This is a constraint on future edits to `layout.ts`:** an unquoted attribute
in that file, or a value interpolated into a `style`, a `<script>`, or a URL context, is not
covered by this function and needs its own encoder.

**Cost if wrong:** an unquoted attribute added later inherits an escaper that does not defend it,
and nothing in the suite would catch it because the assertion is about the values, not the markup
around them.

## Ruling 61 — ruling 51 stayed a written contract, and it binds four later tasks

The brief told the implementer to state the after-commit sending rule in the port's docblock and
**not** to simulate a caller to make it look tested. It did exactly that and said so plainly in its
own "could not verify" list. That is the right outcome and it is recorded here so the next reader
does not mistake an untested contract for an oversight.

**Binds Tasks 8, 10, 11 and 15.** Mail is sent **after** the transaction commits, never inside it.
A send inside the transaction either holds a database transaction open across network I/O to a
third party, or sends "your password was changed" for a change that then rolls back. The second
decides it: an email is not transactional and cannot be recalled.

**Cost if wrong:** the first endpoint that sends mail is Task 8, and whatever pattern it uses is
the pattern the next three copy.

## Ruling 62 — a failed send is not retried, not queued, and nothing alerts on it

ADR-0016 names this, `integrations.md` §7 now names it, and it is repeated here because it is the
largest honest gap in the task. A failed send raises and is logged. For a verification email that
is survivable — **Task 8 must therefore ship a resend path rather than treating the first send as
authoritative.** For a security notice ("your password was changed", "MFA was disabled"), a silent
failure means the signal the notice exists to deliver never arrives, and nothing detects that.

**Owed by Phase 4**, which brings BullMQ; mail delivery belongs on a queue with retries and a
dead-letter path at that point. **Cost if wrong:** an account takeover proceeds unseen because the
notice that would have revealed it failed to send and nobody knew.

## Ruling 63 — a test fixture standing in for a secret must look like a fixture

GitGuardian failed PR #10 with "2 secrets uncovered from the scan of 23 commits" — the branch's own
range, so these were new rather than the three pre-existing phase-1 findings. Two constants of
exactly credential shape, 43 characters of random base64url, indistinguishable from what
`mintSecretToken` actually produces:

- `links.spec.ts` — `const TOKEN = 'HXQ2…'`
- `registry.spec.ts` — `const TOKEN = 'Kd93…'`

Both replaced with `FIXTURE_not_a_real_token-<file>_000…`, which keeps everything the specs
actually need — 43 characters, base64url charset including the `_` and `-` that must survive URL
construction — and none of the entropy. 121 template tests pass unchanged, because the value was
always opaque to them.

**The identification was by shape and count, and the check output later confirmed both files** —
`Generic High Entropy Secret`, one per file, exactly as inferred. The dashboard itself was never
readable from here; the check run's own markdown output was, via
`gh api …/check-runs`, and that is where the correction below came from.

**The first fix was incomplete, and the reason is worth keeping.** Changing the constant at the tip
of the branch left the old value in `1cd9b0a`, the commit that introduced it — and **GitGuardian
scans every commit in a pull request, not the final tree.** The re-run therefore reported the same
two findings, still citing `1cd9b0a`. This is the identical mistake ruling 57 had already paid for
one hour earlier: a value redacted in the working tree is not a value removed from history. Fixed
by a second `filter-branch` over the range, with the same two checks — tree hash
`5d6fe5ead4ca026e70bfac49e6c08444022fc204` on both sides, empty diff against the backup — and the
full suite re-run before the backup was deleted. **The branch was force-pushed**, which is
permitted because only `main` carries branch protection.

This is ruling 57's lesson one layer over, and the pair is worth reading together. There, a **real**
token sat in a ledger and cost a history rewrite. Here, a string that was **never a credential at
all** turned a security product's own security check red — which is the more instructive case,
because no amount of "it isn't actually a secret" makes the check green or makes the next reader
trust it. **Cost if wrong:** none to behaviour; the fixture is opaque to every assertion that uses
it.

**Owed and still not written: `.gitguardian.yaml`.** `roadmap.md` has recorded it as owed since
PR #5, and this task did not write it either — it is not Task 5's, because the three findings it
must name live in `docs/superpowers/ledger/phase-1/review-diffs/` on `main`. The standing cost is
unchanged and now larger: a security product's repository has carried a red security check on every
pull request it has ever had, which trains people to ignore it.

**Outcome, measured after the second rewrite: GitGuardian passed** — "25 commits were scanned
without uncovering any secrets" — alongside `verify` green on both the push and pull-request runs.
And checking that result rather than assuming it corrected a false claim in `roadmap.md`, which said
the repository "has carried a red security check on every pull request it has ever had".
`gh api …/check-runs` over each pull request says otherwise: **#5 failure, #6 failure, #7 success,
#8 failure, #9 success.** PRs #7 and #9 are the documentation follow-ups recording the #6 and #8
merges. Three of four *code* pull requests were red, which is bad enough and is what the roadmap
now says.

