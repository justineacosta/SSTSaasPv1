# Phase 2 · Task 2 — rulings

> **A dated record of what was said and decided at the time. Not a description of current state —
> [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

Dated 2026-08-25. Every decision taken during the task, with **its cost if wrong**.

Rulings 1–6 were taken by the orchestrator **before dispatch** and are reproduced in full in
[`brief.md`](brief.md); only their outcome is recorded here. Rulings 7–13 were taken during the
task, in response to what the implementer and the adversarial reviewer found.

## Taken before dispatch

| # | Ruling | Outcome |
|---|---|---|
| 1 | `Principal` and `TenantContext` are hand-written TypeScript types, not Zod schemas | Held. The reviewer swept the built `dist` for `*Schema` exports and found neither, so no `principalSchema.parse(req.body)` is reachable |
| 2 | Password maximum is 256, not 128 | Held as behaviour — see ruling 7 for the citation defect it carried |
| 3 | `UNKNOWN_FIELD` gets a producer in `ZodValidationPipe`, firing only when **every** issue is `unrecognized_keys` | Held, and independently re-tested by the reviewer including a mixed-failure case |
| 4 | The two ID prefix registries get a cross-check test, living in `packages/db` | Held. The reviewer proved it red in **both** directions by mutating each side in turn |
| 5 | MFA **enrolment** contracts belong to Task 11; Task 2 defines only `mfa/verify` | Held — see ruling 9 for the edge it left |
| 6 | Where a response body is undocumented, define the minimal honest shape and name the owning task | Held; six invented status literals, each commented with its owner |

## Taken during the task

### Ruling 7 — the plan's password citation is false, and this task corrected the code rather than the plan

**Cost if wrong: low to correct, high to leave.** The plan (line 329) and this task's brief both
say the password rule is "no maximum below 128, **per `authentication.md` §2**". The string `128`
appears **nowhere in `.claude/`**, verified by `grep -rn "128" .claude/` — the only hits are a
`1284` row count in two pagination examples, a commit SHA fragment, and two Tailwind breakpoints.
`.claude/security/authentication.md` §2 says only: *"Minimum 12 characters. No composition rules,
no forced rotation."* `.claude/api/authentication.md` §2 is the session flow and says nothing about
passwords. Neither document supports the quoted phrase.

The implementer copied the quotation into a comment in `auth.ts`, where the adversarial reviewer
caught it. **The behaviour is right and unchanged** — `.min(12).max(256)` satisfies §2's floor and
adds a ceiling §2 does not mention — but the ceiling now stands on its own argument (unbounded
input is an Argon2id CPU-exhaustion vector; 128 exactly would refuse a real generated passphrase),
not on a sentence nobody wrote.

The brief was **not** retroactively edited, because a ledger entry records what was said on a date.
The plan was **not** edited either, following Task 1's precedent of recording plan corrections in
the ledger and `roadmap.md` rather than rewriting a dated artefact. This ruling is the correction,
and it is repeated in `progress.md`'s carry-forward list so a later task does not re-derive it.

### Ruling 8 — enum restatements get the same cross-check machinery as the ID prefixes

**Cost if wrong: the spec becomes noise and is deleted, returning to today's state.** Ruling 4 built
a parity spec because two prefix registries had drifted silently. The contracts package restates
three Prisma enums (`OrganizationStatus`, `MembershipStatus`, `SystemRoleKey`) as Zod enums, and the
comments beside them claimed a spec made drift "visible". The reviewer disproved that by
measurement: adding `ARCHIVED` to `enum OrganizationStatus` left both contracts specs green,
because they compare the constant against a literal in the same package.

Ruling: the identical argument applies, so build the identical machinery —
`packages/db/src/enum-parity.spec.ts` against `Prisma.dmmf.datamodel.enums`, with a
`DB_ONLY_ENUMS` allowlist carrying a reason per entry, so adding an enum forces a decision about
whether the client needs to know about it. The false half of both comments was deleted and the
misleading test names (`matches the Prisma …Status enum exactly`) renamed to say what they do.

**A fifth allowlist entry, `ActorType`, was added during implementation** — it exists in the schema
and the brief's list of uncontracted enums had missed it. That is the allowlist working as intended
on its first run.

Values are compared as **sorted sets, not in declaration order**: reordering an enum is unobservable
to a client, and a spec that goes red on it trains people to "fix" it by reordering.

### Ruling 9 — `mfa/verify` gets a response body, because a 200 must have one

**Cost if wrong: one schema, widened or dropped by Task 11.** `api/authentication.md` §2 documents
`POST /auth/mfa/verify -> 200 + Set-Cookie: __Host-session` and shows no body, which sits awkwardly
between ruling 5 ("§2 documents them exactly") and ruling 6 ("define the minimal honest shape").

Ruling: keep `{ status: 'AUTHENTICATED' }`. `api/conventions.md` §2's status table reads
`200 | Success with body` and `204 | Success, no body` — a documented 200 therefore requires a body,
and `logout` gets the opposite treatment in the same file precisely because §2 documents it as 204.

### Ruling 10 — the pagination envelope echoes the applied limit, and it lands now

**Cost if wrong: none in the additive direction; real in the other.** `pagination.md` §4 says a
`limit` above the maximum is clamped and *"the applied limit is echoed in `pagination.limit`"*, and
§1's example envelope shows it. `paginationSchema` had `nextCursor` and `hasMore` only, and
`conventions.md` §4's example agreed with the schema rather than with `pagination.md` — **the two
documents disagreed with each other**, and the schema had picked the stale one.

The implementer deferred this to "the task that ships the first real list endpoint". Overruled: this
task added the clamp and built three collection schemas on the envelope, so the clamp now exists
without the echo, and a client asking for 500 cannot tell a clamp from a short page. Adding a field
to a response is additive under `conventions.md` §8 in either direction, so there is no cost to
landing it now and a real cost to landing it after `check:openapi` has pinned three shapes without
it. `conventions.md` §4's example was corrected in the same change.

### Ruling 11 — `isoTimestampSchema` is UTC-only, and narrowing happens now or never

**Cost if wrong: widening later is additive and free.** The implementer left
`z.string().datetime({ offset: true })`, which accepts `+01:00`, arguing that narrowing is the
breaking direction. That argument is exactly backwards about *when*: narrowing is breaking, which is
why it has to happen while nothing emits a timestamp, no endpoint is published and `check:openapi`
has pinned nothing.

`conventions.md` §3 says "Timestamps ISO 8601 with offset, always UTC (`2026-08-20T14:30:00Z`)", and
"always UTC" is the operative half. These are **response** schemas — they describe what this API
emits, not what it tolerates from a caller — and `apps/api/src/openapi/generate.integration.spec.ts`
already establishes the pattern of parsing live responses with the contract schema. A schema
accepting `+01:00` is a schema that lets a non-UTC response ship past the test written to catch it.

### Ruling 12 — `updateOrganizationRequestSchema` stays a `ZodEffects`, and Task 13 is told

**Cost if wrong: Task 13 restructures one schema.** `.strict().refine(...)` wraps the object, so
`.extend()`, `.partial()` and `.merge()` are unavailable on it. Strictness survives — the reviewer
probed it and got `UNKNOWN_FIELD` at 400. Restructuring to expose an extendable base would export a
second schema whose only purpose is being extended, which is a worse shape than the note. **When
Task 13 adds `requireMfa` or `enforcedEmailDomain` it must rebuild the schema, not extend it.**

### Ruling 13 — the implementer's own report carried a false claim, and it is corrected in the record, not quietly

**Cost if wrong: a future session guards against a hazard that never existed.** The implementer
reported commit `9ed3894` as "prettier-only, caused by writing `index.ts` via a Python script that
produced CRLF". `git show --stat 9ed3894` is one file — `principal.spec.ts`, not `index.ts` — one
insertion and three deletions, and `cat -A` shows LF endings throughout. The real cause is a
`toThrow(...)` call hand-wrapped narrower than prettier's print width. Recorded because the
alternative is a ledger that documents a CRLF hazard this repository has never had.

## Two things nobody could verify, stated as such

- **That the work was genuinely test-first.** All six of the first round's commits contain spec and
  implementation together, so git carries no evidence either way. The implementer's report *does*
  paste red-state output for every behaviour and the fix rounds pasted red-then-green per item,
  including a deliberately mutated schema and a renamed module; that is the evidence there is. The
  reviewer, working only from the repository, could not confirm it and said so.
- **That `check:registry` and `test:integration` were not run in the first round** — a negative
  about another session's history. Both were run afterwards by the fix round and by the
  orchestrator.
