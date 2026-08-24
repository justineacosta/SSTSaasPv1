# Task 13 — scoped re-review of fix round 1 (`6d97bb5..21746c5`)

Re-reviewer: independent, scoped to the 15 findings from `task-13-review.md` plus new breakage
introduced by the fix diff itself. Verified against the code and by running/mutating it, not by
reading the report's description of it.

---

## Per-finding verdicts

**C1 — ADDRESSED.** `apps/web/app/providers.tsx:9` now reads `design-system.md §5 — row
height, padding and font size move together.` `.claude/ui-ux/design-system.md`'s status block
(line 17) now reads `...the §5 density modes are wired to a context that nothing reads.`
Confirmed against the file's actual heading list: `## 4. Signature element — the severity
spine` at line 133, `## 5. Layout and density` at line 147. Also spot-checked other citations
the diff touches: `transport-and-headers.md §3/§4/§6` (Content Security Policy / CORS /
Frontend hardening) all land on the right sections; the new §6 bullet is genuinely inside §6;
the `ui-ux/page-map.md` claim about `(auth)` routes (`/invitations/[token]`, `/reset-password`,
`/verify-email`) is correct (verified via grep on `page-map.md:44-49`); `apps/api` has no CORS
config (`grep -rn "enableCors\|cors(" apps/api/src` → nothing), matching the C2 replacement
text. No new wrong citation found.

**C2 — ADDRESSED.** `.claude/security/transport-and-headers.md` §3 (lines 87-99) no longer
claims the API's CORS policy would reject a cross-origin `report-uri` POST. It now states
plainly that CSP violation reports are not CORS-gated and that `apps/api` has no CORS
configuration at all — both independently verified true (CSP reports are fire-and-forget with
no preflight/ACAO check, and the CORS grep above confirms the second half). The same-origin
decision itself is preserved and now grounded in the two real reasons (API collector 404s;
`document-uri`/`referrer` disclosure).

**I1 — ADDRESSED.** `apps/web/scripts/next-on-web-port.ts` resolves `WEB_PORT` via
`loadEnv(webEnvSchema)` and spawns Next with `--port`; `dev`/`start`/`start:e2e` in
`apps/web/package.json:6-9` all route through it; `playwright.config.ts:11-12` derives
`baseURL` and `webServer.url` from the same `WEB_PORT`. Independently verified live: started
the production server with `WEB_PORT=3187`, `curl` to `:3187` returned `200`, `:3000` returned
no listener (`000`). Process killed and port confirmed released afterward.

**I2 — ADDRESSED.** `apps/web/src/csp-report.ts:37` sets `CSP_REPORT_MAX_BYTES = 8 * 1024`;
`readBoundedBody` (same file, ~line 125) checks `Content-Length` as a fast path and enforces a
running-total cap on the actual stream, cancelling the reader once the budget is exceeded
regardless of what the header claimed. Independently mutation-tested (see "I4 verification"
below) — removing the cap logic fails 3 of the `readBoundedBody` tests in
`csp-report.spec.ts`, confirming the control is load-bearing, not decorative.

**I3 — ADDRESSED.** `sanitizeReportedUrl` in `apps/web/src/csp-report.ts` drops query and
fragment and masks any path segment that isn't a short, lowercase, digit-sparse route name,
applied to both `document-uri` and `referrer` in `parseCspReport`. Independently verified on
the exact realistic input named in the brief: `sanitizeReportedUrl('http://localhost:3000/
invitations/9f8b7c6d5e4f3a2b1c0d9e8f?token=live-secret')` → `'http://localhost:3000/
invitations/:seg'` — the token does not survive. The old "none of them a credential" comment is
gone, replaced with an explicit "what this does not guarantee" caveat (shape heuristic, not a
route table) and a forward-owed action for the phase that ships real token-bearing URLs.

**I4 — ADDRESSED, and independently mutation-verified.** Logic moved to `apps/web/src/
csp-report.ts` with 34 unit tests in `apps/web/src/csp-report.spec.ts` exercising parse,
schema-reject, strip-unknown-keys, mask, and body-bound behaviour directly — none of which pass
if the route is deleted, unlike the pre-fix E2E-only 204 check. I did not take the report's
mutation-testing claim on faith: I edited `sanitizeReportedUrl` to `return raw` (masking
defeated) and got **11 failing tests** (report claimed 8 for a narrower mutation shape — the
broader one I used breaks more, which is consistent, not contradictory); I then edited
`readBoundedBody` to drop both the `Content-Length` fast path and the running-total cap and got
exactly **3 failing tests**, matching the report's count precisely. Both edits were reverted
and confirmed byte-identical via `git status --short` (clean) after restoring.

**I5 — ADDRESSED.** All ten `minimumReleaseAgeExclude` entries are gone from
`pnpm-workspace.yaml`; a comment (lines 23-40ish) records the ruling and the reasoning.
Independently ran `pnpm install --frozen-lockfile` — completed in 247ms, "Already up to date",
no lockfile change, confirming the workspace still installs cleanly without the exclusions.

**I6 — ADDRESSED.** `.claude/product/roadmap.md`'s "Known outstanding" list now contains a
bullet on the missing `eslint-plugin-react`/`eslint-plugin-react-hooks`, stating the gap is a
missing guard rather than a present bug and why Task 13 didn't install it. Independently
confirmed `grep -n react eslint.config.js` still returns nothing, so the underlying gap is real
and accurately described (plugins were deliberately not installed, per instruction).

**I7 — ADDRESSED.** `roadmap.md`'s "Known outstanding" list now states "**Task 14 owes a CI
end-to-end stage — a browser install and `pnpm test:e2e`. Required, not suggested**," in the
same bolded, self-contained shape as the pre-existing vitest-project-guard carry-forward
bullet. CI itself is untouched, consistent with the ruling that the edit belongs to Task 14.

**M1 — ADDRESSED.** `apps/web/next-env.d.ts` is untracked (`git ls-files` returns nothing for
it) but still present on disk; `.gitignore:9-15` adds the entry with a comment explaining why
(command-dependent rewrite) and citing the verified-safe clean-clone typecheck consequence.

**M4 — ADDRESSED.** `apps/web/proxy.ts:59-61` now calls `requestHeaders.delete('Content-
Security-Policy')` and `requestHeaders.delete('Content-Security-Policy-Report-Only')`
unconditionally before setting whichever one is active, closing the report-only-mode gap where
a client-supplied header under the other name could have survived.

**M5 — ADDRESSED.** `apps/web/e2e/smoke.spec.ts:12` adds `await page.waitForLoadState
('networkidle')` before the `errors` assertion in the "no console errors" test, with a comment
explaining the race it closes.

**M6 — ADDRESSED.** `transport-and-headers.md` §3's log sample now shows the pretty-printed
form (`[18:18:43.837] WARN: ...`) and states it was captured "against the running dev server,
which is where `apps/web/src/logger.ts` emits the pretty form rather than JSON (`pretty:
APP_ENV === 'development'`)". Confirmed `logger.ts:26` sets `pretty: env.APP_ENV ===
'development'`, so the label and the sample now agree.

**M7 — ADDRESSED.** `roadmap.md` line 138 now reads "**Tasks 1–13 are complete.** Task 13 was
implemented, independently reviewed ... and the fix round that corrected them has landed,"
replacing the premature completion claim. True at time of writing (review has landed, fixes
verified in this round).

**M2 / M3 — correctly left untouched**, per the explicit no-action ruling; confirmed no diff
hunks touch `(auth)/layout.tsx` or the appearance-context wiring.

---

## New breakage in the fix diff — none found (Critical/Important)

Reviewed every file the fix diff touches for regressions the fix round itself could have
introduced, and ran the actual code rather than trusting the report:

- `apps/web/src/csp-report.ts` / `route.ts` — full unit suite (34 tests) passes; mutation
  testing (above) confirms both the masking and the body-cap controls are real, not
  decorative. `route.ts` is now a thin wrapper with no independent logic to regress.
- `apps/web/scripts/next-on-web-port.ts` — independently started a production server on a
  non-default port and confirmed binding; `dev`/`start`/`start:e2e` all route through it
  correctly.
- `apps/web/proxy.ts` — the double-delete is unconditional and precedes the single `set`, so
  it cannot suppress the nonce header the app depends on (confirmed logically; not
  independently re-run against a live enforcing-mode request in this round, but the change is
  a pure two-line addition ahead of existing, previously-verified logic).
- Full workspace `pnpm lint` and `pnpm typecheck` both green (Turbo full cache hit on
  restored/matching content); `npx vitest run --project unit --project ui --passWithNoTests` →
  27 files / 321 tests pass, matching the report's count exactly.
- `pnpm install --frozen-lockfile` succeeds after the `pnpm-workspace.yaml` edit.
- Working tree confirmed clean (`git status --short` empty) both before and after my temporary
  mutation edits.

No Critical or Important defect was introduced by this commit.

## Out of scope, for the ledger

- Did not independently re-run the Playwright suite in this round (relies on Docker/dev-server
  lifecycle beyond the scope budget here); relied on the report's `5 passed` output plus my own
  independent live-port test as a proxy for the launcher/config wiring I1 depends on.
- `apps/web/proxy.ts`'s nonce-forwarding path was not re-probed live against an enforcing CSP
  in this round (M4's fix is a narrow, low-risk two-line addition ahead of previously-verified
  logic; static review only).
- Everything the original review marked "genuinely correct" and this fix diff did not touch
  (Tailwind single-emission, font self-hosting, header table on edge paths, etc.) was not
  re-verified — out of scope for a fix-round re-review.

---

## all findings addressed
