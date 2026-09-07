# Task 17 — adversarial review

> **A dated record of what was found at review time. Not a description of current state —
> [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

Fresh adversarial reviewer, 2026-09-07. Branch `feat/phase-2-task-17-app-shell`, range
`5dbab4e..HEAD` (commits `6118952..7463389`). The reviewer did not write this code.

Written incrementally from the first minutes and committed as it went (ruling 131).

## Status: IN PROGRESS

## Pass 1 — citation (in progress)

## Pass 2 — code (not started)

## Findings (in progress)

## Checked and found fine (in progress)

---

## Pass 1 — citation. Do the reported numbers reproduce?

Every command re-run by the reviewer at the repository root on `HEAD` of
`feat/phase-2-task-17-app-shell`, exit code captured outside a pipe, compose stack up
(`sentinel-postgres-1`, `sentinel-redis-1`, `sentinel-minio-1`, `sentinel-mailpit-1`, all
`Up (healthy)`).

| Report claim | Reviewer's re-run | Verdict |
|---|---|---|
| `pnpm test` 0, 115 files / 1970 tests | exit 0, **115 files / 1970 tests** | reproduces |
| `pnpm check:specs` 0, 144 spec files | exit 0, **"144 spec files, each claimed by exactly one of: unit, integration, ui"** | reproduces |
| `pnpm check:openapi` 0, 29 routes, byte-identical | exit 0, `"routes":29`, **"byte-identical to what the contracts generate"** | reproduces |
| `pnpm check:registry` 0, 15 models / 3 tenant-owned / 1 tenant root / 11 global | exit 0, **"15 models, 3 tenant-owned, 1 tenant root, 11 deliberately global"** | reproduces — `Session` did **not** drift into the tenant registry |
| `pnpm check:secrets` 0, 520 tracked files | exit 0, **"520 tracked files, no credential-shaped literals"** | reproduces |
| 29 OpenAPI paths, session routes are `/auth/session`, `/auth/sessions`, `/auth/sessions/{sessionId}` | `node -e` over `apps/api/openapi.json`: **29**, exactly those three | reproduces |

Other Step-2/Step-3 claims opened and confirmed:

- `logout.service.ts:56-73` really does carry the "audit row is NOT in the same transaction"
  compromise, with the same revoke-then-audit ordering and the same reasoning. **The precedent is
  real, not merely similar.**
- `logout.service.ts:84-86` discards `revoke`'s boolean and audits unconditionally;
  `session-management.service.ts:177-183` audits only on `'REVOKED'`. **The "stricter than logout"
  claim is true.**
- Cookie clearing at `auth.controller.ts:789` is byte-identical to `logout`'s at `:514`
  (`response.setHeader('Set-Cookie', [clearedSessionCookie(), clearedCsrfCookie()])`). The end
  state genuinely matches `POST /auth/logout`; there is no half-cleared pair.
- `app-setup.ts:127` installs exactly one global interceptor (`LoggingInterceptor`). No response
  is validated against a contract schema anywhere. See finding C-1.
- No guard, middleware or interceptor sets a session cookie — only `auth.controller.ts` does
  (grep for `Set-Cookie`/`setHeader` across `apps/api/src`), so nothing can overwrite the cleared
  pair after the handler returns.
- Bulk revocation's "tombstoned before the rows are written" is true: `session.service.ts:885-895`
  runs **two** poison passes and the first precedes the `updateMany`. Checked because
  `revokeLiveForUser` reads hashes back *after* the write and the ApiDoc claim looked false; it
  is not.
