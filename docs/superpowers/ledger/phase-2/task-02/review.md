# Phase 2 · Task 2 — adversarial review

> **A dated record of what was said and decided at the time. Not a description of current state —
> [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

Dated 2026-08-25. A fresh reviewer that did not write the code, per the plan's Execution protocol
§2 ("the adversarial reviewer is always fresh, for every task, in every mode"). **Citation pass
first, code second** (§3).

## Citation pass — 25 claims from the implementer's report, re-verified against the repository

Twenty-three true, two false. The two false ones are recorded as findings F1 and F2 below; the
substance of the true ones is in [`report.md`](report.md).

The reviewer re-ran all eight verification commands itself rather than accepting the reported exit
codes, confirmed the 23-file diff with `git diff --stat ca88312 HEAD`, confirmed
`apps/api/openapi.json` is absent from the diff, and confirmed `git status --porcelain` empty.

One claim was **unverifiable in principle** and marked as such rather than guessed: that
`check:registry` and `test:integration` were not run during the implementer's session is a negative
about another session's history.

## Findings

Severity as the reviewer ranked them. The orchestrator's disposition is the right-hand column.

| # | Sev | Finding | Disposition |
|---|---|---|---|
| F1 | High | `auth.ts` quotes `"no maximum below 128"` as coming from `authentication.md` §2. `grep -rn "128" .claude/` proves the string is not in that file or any other | **Fixed** — comment rewritten; recorded as [ruling 7](rulings.md) |
| F2 | High | The report's stated cause for commit `9ed3894` is wrong: the commit is `principal.spec.ts`, not `index.ts`, and has no CRLF | **Corrected in the record** — [ruling 13](rulings.md) |
| F3 | Medium | `organizations.ts` and `memberships.ts` claim their specs make Prisma-enum drift "visible". Disproved by measurement: adding `ARCHIVED` to `enum OrganizationStatus` left both green | **Fixed** — `enum-parity.spec.ts` built, comments corrected, misleading test names renamed; [ruling 8](rulings.md) |
| F4 | Medium | `paginationSchema` omits `limit`, contradicting `pagination.md` §1 and §4 | **Fixed** — field added; `conventions.md` §4's example corrected in the same change; [ruling 10](rulings.md) |
| F5 | Medium | `tenant-context.spec.ts` is runtime-vacuous — all four tests pass with the module deleted. Its comment claims it "fails loudly" | **Fixed** — side-effect import added and proven by renaming the module; comment now names `pnpm typecheck` as the enforcing command |
| F6 | Low | `timestamps.ts` shipped with no spec, and the omission was not declared | **Fixed** — spec written, then proven non-vacuous by weakening the schema |
| F7 | Low | The pipe spec attributes to `errors.md` §7 a call-out §7 does not make | **Fixed** — reworded to §7's actual general rule |
| F8 | Low | `errors.md` is now stale on `UNKNOWN_FIELD`; the brief forbade the implementer from touching `.claude/` | **Fixed by the orchestrator**, which owns those files |
| F9 | Low (taste) | `mfaVerifyResponseSchema` invents a body where §2 shows none | **Kept** — [ruling 9](rulings.md): `conventions.md` §2 makes 200 a status with a body |
| F10 | Low (taste) | `updateOrganizationRequestSchema` is a `ZodEffects`, so Task 13 cannot `.extend()` it | **Comment only** — [ruling 12](rulings.md) |
| F11 | Low (taste) | `z.coerce.number()` accepts `true` as `limit: 1` | **Not changed.** Query-string values arrive as strings; `null`, `''` and arrays are already rejected |

## What the reviewer checked and found correct

Recorded because the coverage of a review is as much a part of the record as its findings.

- **Ruling 4 proven by mutation, in both directions.** Added `zzz` to `packages/db`'s `ID_PREFIXES`
  → red on `unaccounted`. Added `widget: 'wdg'` to the contracts map → red on `missing`. Both
  reverted, tree left clean.
- **Ruling 3 re-tested independently**, including the case the ruling turns on: an unknown key plus
  a real rule failure stays `VALIDATION_ERROR` **and** still lists the unknown key. The reviewer
  also fed a credentialed URL in as an unknown **key name** — `https://admin:sup3rs3cret@…` — and
  confirmed the password does not survive into `path` or `message`.
- **`.strict()` on every request schema**, established by introspecting `_def.unknownKeys` on all
  63 exported schemas in the built package rather than by reading: 15 request/query schemas strict,
  15 response/collection schemas strip, `updateOrganizationRequestSchema` strict beneath its
  refinement.
- **No token, hash or secret in any response schema**, probed by feeding `invitationResponseSchema`
  a row carrying both `token` and `tokenHash` (both stripped) and `sessionResponseSchema` a
  `sessionToken` (stripped).
- **Enumeration resistance is expressible**: register, resend-verification and forgot-password
  responses are constant literals with no account-dependent field, so a distinguishing response
  cannot be expressed through the contract.
- **`loginResponseSchema` matches `api/authentication.md` §2 exactly** — the two shapes, no third;
  `{ mfaRequired: true }` without a token is refused.
- **The enum values agree today**, read from the DMMF rather than from the schema text.
- **Nine ID prefixes, all exactly three characters** (`parseIdPrefix` hard-codes three), no
  duplicates, each mapping to a real model.
- **No out-of-scope work**: no controllers, services, guards or modules; no migration; no
  `roadmap.md` or `.claude/` edit; the only `apps/api` change is the permitted pipe change.
- **Project rules**: no `any`, no `console.log`, no `process.env`, every file under 300 lines
  (largest `auth.ts` at 243), deep-path imports structurally impossible because
  `packages/contracts/package.json` publishes only the `"."` export under `nodenext`, and
  `index.ts` re-exports every named export of all nine modules (checked programmatically).
