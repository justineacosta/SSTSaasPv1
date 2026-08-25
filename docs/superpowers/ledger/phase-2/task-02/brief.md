# Phase 2 · Task 2 — brief

> **A dated record of what was said and decided at the time. Not a description of current state —
> [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

Dated 2026-08-25. Written by the orchestrator before dispatch.

**Task:** `packages/contracts` — identity contracts, `Principal`, `TenantContext`.
**Plan section:** `docs/superpowers/plans/2026-08-24-phase-2-identity.md`, "Task 2".
**Mode:** fresh implementer subagent + separate adversarial reviewer. The plan's Execution protocol
§2 says Task 2 may be either mode and that **the choice is recorded in the ledger**; the choice is
subagent, matching the row already in `progress.md`.
**Branch:** `feat/phase-2-identity`. Nothing is pushed.

## What the previous task left, and what was re-verified before dispatch

Task 1 is verified, re-run by this session rather than taken from its report: `pnpm test`
32 files / 416 tests, `pnpm test:integration` 11 files / 148 tests, `pnpm typecheck` 14 tasks,
`pnpm check:registry` 14 models, `pnpm check:specs` 43 spec files — all exit 0, Docker running.

Task 1's carry-forward rulings 5, 6 and 9 in
[`../progress.md`](../progress.md) bind this task. Ruling 5 is the one that creates work here:
`packages/db/src/id.ts`'s `ID_PREFIXES` and `packages/contracts/src/ids.ts` are **independent lists
with no cross-check, and they already disagree**. Task 2 owns extending both, plus a prefix for
`IdentityProviderLink`, which the plan omits.

## Orchestrator rulings taken before dispatch

Six places where the plan's text does not resolve against what is in the repository. Each is
recorded with the cost if the ruling is wrong, per the phase's ledger convention. **The implementer
follows these; it does not relitigate them.** If one turns out to be impossible, stop and report —
do not silently choose differently.

### Ruling 1 — `Principal` and `TenantContext` are hand-written TypeScript types, not Zod schemas

The plan's first bullet says types are **inferred** with `z.infer`, never hand-written beside the
schema. That rule governs the **wire contracts** — request and response bodies. `Principal` and
`TenantContext` are not wire contracts: they are constructed server-side by the authentication guard
(Task 7) and the tenant-resolution guard (Task 12) out of trusted database state, and are never
parsed from an external input.

Ruling: **declare them as plain TypeScript types.** Do not give them Zod schemas.

*Why:* Zod at the boundary means at the boundary. A `principalSchema` in the exported surface is an
affordance for someone to `principalSchema.parse(req.body)` and mint a principal out of
attacker-controlled JSON — the single worst mistake available in this phase. Also, `TenantContext`'s
`permissions: ReadonlySet<Permission>` has no Zod representation: `z.set()` produces a mutable `Set`,
so a schema would silently weaken the type.

*Cost if wrong:* if a later task genuinely needs to serialise a `Principal` over the wire, it defines
a **separate response schema** for that (see `sessionResponseSchema` below), which is the correct
shape anyway — the wire representation of a session is not the internal principal object.

### Ruling 2 — password maximum is 256, not 128

`.claude/security/authentication.md` §2 and the plan both say minimum 12, no composition rules, **no
maximum below 128**. That is a floor on the maximum, not the maximum.

Ruling: `.min(12).max(256)`.

*Why:* 128 exactly would refuse a real generated passphrase; unbounded would hand an attacker a
cheap Argon2id CPU-exhaustion vector, since hashing cost rises with input length. 256 satisfies the
documented floor and bounds the cost.

*Cost if wrong:* one character in one schema and a spec constant. Cheap to change while no password
has been hashed.

### Ruling 3 — `UNKNOWN_FIELD` gets a producer, in `ZodValidationPipe`

The plan asks for "one spec proving an unknown field is a **400 with `UNKNOWN_FIELD`**".
`packages/contracts` has no HTTP layer and cannot produce a status code, and
`apps/api/src/common/pipes/zod-validation.pipe.ts` currently raises `VALIDATION_ERROR` for **every**
Zod failure. So today nothing in the repository can produce `UNKNOWN_FIELD` — it is a documented
code (`api/errors.md` §3) with no producer, which §7 of that document already calls out as unmet.

Ruling, and it is two separate pieces of work:

1. **In `packages/contracts`:** a spec proving a `.strict()` request schema rejects an unknown key
   with a Zod `unrecognized_keys` issue. That is the schema-level fact and it is all contracts can
   assert.
2. **In `apps/api`:** extend `ZodValidationPipe` so that when **every** issue in the failure is
   `unrecognized_keys`, the `DomainError` carries `ERROR_CODES.UNKNOWN_FIELD` at 400 instead of
   `VALIDATION_ERROR`; a mixed failure stays `VALIDATION_ERROR` **and still lists the unrecognised
   keys in `details.fields`**. Expand an `unrecognized_keys` issue into **one field error per key**,
   with `path` set to the full dotted/bracketed path of the offending key — Zod puts the parent path
   on that issue and the keys in `issue.keys`, so the existing `formatPath` alone would emit an
   empty path and name no field.

*Why "every issue" rather than "any issue":* a body that both misspells a field and fails a real
validation rule is a validation failure; branching it to `UNKNOWN_FIELD` would tell the client the
only problem was the spelling. Never hide a validation failure behind a different code.

*Cost if wrong:* the split is one conditional in one file. If the API later wants `UNKNOWN_FIELD` on
any occurrence, that is a one-line change plus a test, and it is **additive to the client** in
neither direction — a client branching on `VALIDATION_ERROR` would start seeing `UNKNOWN_FIELD`.
That is a contract change under `api/conventions.md` §8, so this is the moment to get it right,
before any endpoint ships.

### Ruling 4 — the two ID prefix registries get a cross-check test, and it lives in `packages/db`

Carry-forward ruling 5 says the two lists are independent and already disagree. Extending both by
hand fixes today's drift and does nothing about tomorrow's.

Ruling: `packages/contracts/src/ids.ts` declares **one** source-of-truth prefix map and derives every
`*IdSchema` from it, exporting the map. `packages/db` — which already depends on `@sentinel/contracts`
— carries a spec asserting the two maps agree, **modulo an explicitly named `DB_ONLY_PREFIXES`
allowlist with a one-line reason per entry**. Adding a prefix to either side without touching the
other turns that spec red.

Direction matters: the dependency is db → contracts, never the reverse. The spec must live in
`packages/db`.

*Why an allowlist rather than equality:* some db prefixes have no client-facing ID schema (`req` is a
request ID, `crd` a credential row nobody addresses by ID). Requiring equality would force
meaningless schemas; requiring subset alone would let a new db prefix be added with no thought about
the client. The allowlist forces the thought and records the answer.

*Cost if wrong:* if the allowlist becomes noise, the spec is deleted and the drift returns to being
invisible — which is exactly today's state, so the downside is bounded at "no worse than now".

### Ruling 5 — MFA **enrolment** contracts belong to Task 11; Task 2 defines only `mfa/verify`

`api/authentication.md` §2 documents five session-flow endpoints. MFA *enrolment* (start, confirm,
disable, regenerate recovery codes) is documented nowhere as a wire contract, and Task 11 owns
`mfa.service.ts` and its controller additions.

Ruling: Task 2 defines `mfa/verify`'s request and response, because §2 documents them exactly. It
does **not** invent enrolment contracts.

*Cost if wrong:* Task 11 writes four schemas in the file Task 2 created, in the house style Task 2
established. Cheap. Inventing them now is the expensive direction — a guessed shape that
`check:openapi` then pins.

### Ruling 6 — where a response body is undocumented, define the minimal honest shape and say who owns it

`api/authentication.md` §2 documents login, mfa/verify, logout, session and switch-org precisely.
Register, verify-email, resend-verification, forgot-password, reset-password and change-password are
named by Tasks 8 and 10 but their **response bodies are documented nowhere**.

Ruling: define the **request** schemas fully — those are constrained by the password policy, the
email rule and `.strict()` — and give each undocumented response the minimal shape the endpoint's
described behaviour requires, with a comment naming the task that owns refining it.

*Why:* the enumeration-resistance rule makes several of these responses deliberately contentless.
Guessing a rich body now would be a shape `check:openapi` pins in place before the endpoint exists.

*Cost if wrong:* a later task widens a response schema. Widening is additive under
`api/conventions.md` §8; narrowing is not — so err toward the smaller shape, which this ruling does.

## Scope

### Files to create

| File | Contents |
|---|---|
| `packages/contracts/src/principal.ts` | `Principal` discriminated union (+ spec) |
| `packages/contracts/src/tenant-context.ts` | `TenantContext` (+ spec) |
| `packages/contracts/src/auth.ts` | Authentication request/response schemas (+ spec) |
| `packages/contracts/src/organizations.ts` | Organisation schemas (+ spec) |
| `packages/contracts/src/memberships.ts` | Membership and role schemas (+ spec) |
| `packages/contracts/src/invitations.ts` | Invitation schemas (+ spec) |
| `packages/db/src/id-prefix-parity.spec.ts` | Ruling 4's cross-check |

A spec per file, `*.spec.ts`, beside the source — the house convention `check:specs` enforces.

### Files to modify

| File | Change |
|---|---|
| `packages/contracts/src/ids.ts` | Single prefix map; add `ses`, `mfa`, `vtk`, `rcv`, `idp` |
| `packages/contracts/src/index.ts` | Export everything new |
| `packages/db/src/id.ts` | Add `mfa`, `vtk`, `rcv`, `idp` to `ID_PREFIXES` (`ses` is already there) |
| `apps/api/src/common/pipes/zod-validation.pipe.ts` | Ruling 3's `UNKNOWN_FIELD` branch |
| `apps/api/src/common/pipes/zod-validation.pipe.spec.ts` | Ruling 3's specs |

### Checklist

- [ ] **`ids.ts` — one map, schemas derived.** Every existing export
      (`idSchema`, `organizationIdSchema`, `userIdSchema`, `membershipIdSchema`, `invitationIdSchema`)
      keeps its name and behaviour. Add `sessionIdSchema` (`ses`), `mfaFactorIdSchema` (`mfa`),
      `verificationTokenIdSchema` (`vtk`), `recoveryCodeIdSchema` (`rcv`),
      `identityProviderLinkIdSchema` (`idp`).
- [ ] **`packages/db/src/id.ts`** gains `mfa`, `vtk`, `rcv`, `idp`. Do not remove or rename anything
      already there. `parseIdPrefix` hard-codes three characters — every new prefix is three
      characters, which is why `idp` and not `idpl`.
- [ ] **Ruling 4's parity spec** in `packages/db`.
- [ ] **`principal.ts`** — `{ kind: 'user'; userId: string; sessionId: string }` |
      `{ kind: 'apiKey'; keyId: string; organizationId: string; permissions: readonly Permission[] }`.
      The API-key arm is **defined and unimplemented in Phase 2**. Export a narrowing helper for the
      user arm, and a function that throws a clearly-worded `API key principals are not implemented
      in Phase 2` error for the apiKey arm — code that must handle it **throws rather than silently
      allowing**. Its spec asserts the throw, and asserts the union is exhaustive (a `never` check).
- [ ] **`tenant-context.ts`** — `{ organizationId: string; membershipId: string; roleKey: SystemRole;
      permissions: ReadonlySet<Permission> }`. This is what handlers receive and what the
      tenant-scoped Prisma client is bound to. Its spec proves the set is genuinely read-only at the
      type level (a `@ts-expect-error` on a `.add()` call is the cheapest proof).
- [ ] **`.strict()` on every request schema, without exception.** `api/conventions.md` §3: unknown
      fields are **rejected**, not ignored. Response schemas are not `.strict()`.
- [ ] **Password policy** — `.min(12).max(256)` per Ruling 2, no composition rules. A spec asserts a
      12-character **all-lowercase** password is *accepted*, that 11 is refused, and that 256 is
      accepted. A reviewer who "helpfully" adds a symbol requirement must see a test go red.
- [ ] **Email** — a single `emailSchema` used everywhere, lowercased and trimmed at the boundary
      (`.trim().toLowerCase()`), because `User.email` is `@unique` and the database will not
      case-fold for you. One spec on that transform.
- [ ] **`auth.ts`** — request and response schemas for: `register`, `verify-email`,
      `resend-verification`, `login`, `mfa/verify`, `logout`, `session`, `switch-org`,
      `forgot-password`, `reset-password`, `change-password`. `loginResponseSchema` is a
      **discriminated union on `mfaRequired`**: `{ mfaRequired: false }` or
      `{ mfaRequired: true, pendingToken }` — exactly the two shapes in `api/authentication.md` §2
      and nothing else. `sessionResponseSchema` carries the principal's user id, the active
      organisation (nullable — a user may be signed in before choosing one), the effective permission
      set, and an **entitlements placeholder**; §2 and Task 9 both name those four.
- [ ] **`organizations.ts`, `memberships.ts`, `invitations.ts`** — create/update/list/response
      schemas for the endpoints named in the plan's Tasks 13, 14 and 15. Roles are
      `z.enum(SYSTEM_ROLES)` from `permissions.ts`, never a re-declared string list. Statuses match
      the Prisma enums exactly.
- [ ] **List query schemas paginate.** `api/pagination.md` §1: cursor pagination is the default —
      `limit` (bounded, with a default) and an opaque `cursor`. No list query may omit a bounded
      `limit`; "every list endpoint paginates, there are no unbounded list endpoints" is a core rule,
      not a Phase 13 detail.
- [ ] **`index.ts` exports everything.** Nothing in `apps/*` may import from a deep path. Values and
      types exported in the file's existing style (`export { … }` then `export type { … }`).
- [ ] **Timestamps** are ISO 8601 strings in responses (`z.string().datetime({ offset: true })`),
      never `Date` — `api/conventions.md` §3.
- [ ] Enum values are `SCREAMING_SNAKE_CASE` strings, per §3.

### Explicitly out of scope

- **No NestJS controllers, services, guards or modules.** No endpoint is implemented in this task.
  The only `apps/api` change permitted is Ruling 3's pipe change and its spec.
- **No database migration.** The schema is Task 1's and is finished.
- **No MFA enrolment contracts** (Ruling 5).
- **No API-key issuance, acceptance or storage anywhere** — the `Principal` arm is a type and a
  throw, nothing more. API keys are deliberately not in Phase 2.
- **No `roadmap.md` edit, no `.claude/` narrative, no status prose.** See below.

## Rules that are review-blocking

- **You report commands and exit codes, not prose** (plan, Execution protocol §3). No "this now
  works", no summary paragraphs, no `roadmap.md` edits, no `.claude/` narrative. The orchestrator
  writes every sentence that asserts anything. Phase 1's recurring defect was 12 false factual
  claims in written prose, five of them introduced while correcting an earlier one.
- **Test-first.** For each schema, the spec that pins its behaviour is written and seen to fail
  before the schema satisfies it. Report the red state, not just the green one.
- TypeScript strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`. **No `any` without a
  written justification comment.**
- `process.env` only inside `packages/config`. No `console.log`.
- Files under ~300 lines.
- Conventional commits ending with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
  Commit frequently on `feat/phase-2-identity`. **Never commit to `main`. Never push.**
- Comments explain **why**, in the house style already in `ids.ts`, `permissions.ts` and
  `zod-validation.pipe.ts` — reasoning first, and reasoning that would stop the next person
  undoing the decision.

## Verification, to be reported as a table of command → exit code → result

```
pnpm test
pnpm typecheck
pnpm build:packages
pnpm lint
pnpm format:check
pnpm check:specs
pnpm check:openapi
pnpm build
```

`pnpm check:openapi` is in the list because Ruling 3 touches `apps/api`. If the committed
`apps/api/openapi.json` changes, **stop and report it** rather than regenerating — a Task 2 that
moves the published contract is a finding, not a step.

`pnpm test:integration` is not required unless the parity spec (Ruling 4) needs a database; it
should not — it compares two in-process constants.
