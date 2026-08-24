# Task 13 review — `apps/web` Next.js App Router shell

Reviewer: independent adversarial reviewer. Range `8478963..6d97bb5`.

- **Spec compliance: ✅** (one real miss, `WEB_PORT` — see I1)
- **Task quality: Approved** (conditional on C1 and C2 being corrected)

---

## Verification log (what was actually run, not read)

- `npx vitest run --project unit --project ui --passWithNoTests` →
  26 files / 287 tests pass, and `apps/web/src/security-headers.spec.ts (9 tests)`
  appears under the `unit` project tag. **Vitest project routing verified: the one
  new vitest spec is claimed by exactly one project and actually executes.**
  `apps/web/e2e/smoke.spec.ts` is outside `apps/*/src/**`, so no vitest project
  claims it; Playwright's `testDir: './e2e'` + default `testMatch` does. Correct.
- Token existence checked against `packages/ui/src/tokens.css`: every custom
  property referenced by the new components (`--color-bg`, `--color-text`,
  `--color-text-muted`, `--color-text-subtle`, `--color-border`,
  `--color-surface`, `--color-accent`, `--text-{display,title,heading,subhead,
  body,sm,caption,micro}` and each paired `--leading-*`) exists. No raw hex in
  `apps/web`.
- `react@19.2.8`'s `react-server` build does export `forwardRef`, so
  `packages/ui`'s ref-forwarding primitives rendering inside RSC pages is fine.

### Live server probes (`next start`, `APP_ENV=test` → CSP enforcing)

Started the tracked production build and measured real responses:

- `GET /` — full §2 header table present, `Content-Security-Policy` (enforcing)
  identical in text to `buildSecurityHeaders`, `Cache-Control: private, no-cache,
  no-store, max-age=0, must-revalidate` from Next itself. **The claim in
  `src/security-headers.ts` and in `app/(app)/layout.tsx` that Next already sends
  `no-store` on dynamic HTML is TRUE.**
- The rendered HTML carries **18 `nonce="…"` attributes across 16 `<script>` tags
  plus the one `<link rel=stylesheet>`**, all equal to the nonce in the response
  CSP. **The nonce is genuinely per-request and genuinely reaches the HTML.**
  Two successive `GET /dashboard` requests produced two different nonces.
- `GET /_next/static/chunks/*.js` — the security headers **do** apply, and the
  response carries `Cache-Control: public, max-age=31536000, immutable`.
  **The `security-headers.ts` divergence-1 justification is measured-true**: a
  blanket `no-store` here would have discarded that.
- Header coverage on edge paths, all carrying the full table + CSP:
  `/nope` 404, `/favicon.ico` 404, `/robots.txt` 404, `/_next/image?url=x` 400.
  **"Every response leaves through this table" is true, including error responses
  and static assets. No path found where a response leaves without the headers.**
- No inline `<style>` tags and no `style="…"` attributes in the rendered HTML, so
  `style-src 'self' 'nonce-…'` (no `unsafe-inline`, and therefore no
  `style-src-attr` fallback) does not break anything today.
- Built CSS (`/_next/static/chunks/451pm4kab04a8.css`, 25 KB): preflight emitted
  **exactly once** (`tab-size:4` ×1, `:-moz-focusring` ×1). **Task 12
  carry-forward #1 (one `@import 'tailwindcss'`) verified in the built output, not
  just in the source.** Every arbitrary-value utility used by the new components
  is present in the emitted CSS, including `rounded-[var(--radius-card)]` which
  appears only inside `packages/ui` — proving the
  `@source '../../../packages/ui/src'` line in `globals.css` is load-bearing.
- The `globals.css` claim that preflight's only `outline` rule is
  `:-moz-focusring:where(:not(iframe)){outline:auto}` is **TRUE** — verified by
  grepping the emitted stylesheet.
- Fonts: 20 `.woff2` under `.next/static/media`; `@font-face` rules for IBM Plex
  Sans 400/500, Sans Condensed 600 and Mono 400/500 with `src:url(../media/…)`;
  **zero** occurrences of `googleapis`/`gstatic` in the built HTML or CSS.
- `npx playwright test` against that server: **5/5 pass** in 1.4 s, including
  "no console errors" under an *enforcing* CSP. The E2E suite is real and green.

### Static and lint probes

- `npx turbo run lint typecheck --filter=@sentinel/web --force` → 5/5 green,
  nothing cached.
- Hex-colour lint rule re-verified independently: a throwaway
  `apps/web/src/__hexprobe__.tsx` containing `style={{ color: '#ff0000' }}` and a
  template-literal hex class produced **2 `no-restricted-syntax` errors**.
  `design-system.md` §7's new claim is TRUE. Probe deleted; tree left clean.
- Typecheck with `apps/web/.next` **deleted entirely**
  (`tsc -p apps/web/tsconfig.json --noEmit --incremental false --listFiles`):
  exit 0, 19 `apps/web` files checked, `next-env.d.ts` read, and its two
  `import "./.next/types/…"` lines did **not** produce an error. So the tracked
  `next-env.d.ts` does not break a clean-clone CI typecheck.
- `apps/api` has **no CORS configuration of any kind** (`grep` for
  `enableCors`/`cors` across `apps/api/src` → nothing). Relevant to C2.
- `enforceCsp` in `apps/web/src/env.ts` is `env.APP_ENV !== 'development'`;
  `apps/api`'s `CSP_ENFORCE` factory is `env.APP_ENV !== 'development'`. The
  "identical rule and identical derivation" claim is TRUE, and the report-only /
  enforce switch derives from exactly one place.
- `data-density`: zero occurrences in `packages/ui/src/tokens.css` and zero in the
  built stylesheet. Confirms the density context is inert (see M3).
- `design-system.md` heading list confirmed: §1 thesis, §2 typeface, §3 colour,
  §4 severity spine, §5 layout and density, §6 motion, §7 tokens, §8 voice.
  Relevant to C1.

---

## Verdict 1 — Spec compliance: ✅

Requirement by requirement against `task-13-brief.md`:

| Brief item | Status |
|---|---|
| `apps/web/package.json`, `tsconfig.json`, `next.config.ts`, `playwright.config.ts` | ✅ Present, ESM (`"type": "module"`), extends `tsconfig.base.json` with only Next-forced overrides, each override commented. |
| `apps/web/middleware.ts` | ⚖️ **Ruled** — shipped as `proxy.ts`. Implementation correct: exported function named `proxy`, no `config.matcher` (so it covers everything — verified), Node runtime. |
| `app/{layout.tsx,globals.css,fonts.ts,providers.tsx}` | ✅ All four. |
| `(marketing)/page.tsx`, `(auth)/layout.tsx`, `(app)/layout.tsx` | ✅ |
| `(app)/page.tsx` | ⚖️ **Ruled** — `(app)/dashboard/page.tsx`. |
| `app/api/csp-report/route.ts`, `app/api/health/route.ts` | ✅ Both, both `runtime = 'nodejs'`; health also `force-dynamic` + `no-store`. |
| `e2e/smoke.spec.ts` | ✅ Brief's three tests **verbatim**, plus two added. |
| `src/security-headers.spec.ts` | ✅ Brief's six tests **verbatim**, plus three added. |
| Consumes `@sentinel/ui` and `@sentinel/config` (`webEnvSchema`) | ✅ tokens + Card/Alert/Badge; `loadEnv(webEnvSchema)` in `src/env.ts`. |
| Produces an app **on `WEB_PORT`** | ❌ **Not met** — see I1. `WEB_PORT` is parsed and never used. |
| `buildSecurityHeaders(nonce, enforceCsp): Record<string,string>` — pure, shared by proxy and test | ✅ Exact signature, no Next import, no I/O, genuinely shared. |
| Step 2: per-request nonce, forwarded on a request header for `layout.tsx` | ✅ `x-nonce` set (and overwritten, so unspoofable) plus the CSP header, which is the one Next actually reads. |
| Step 3: three IBM Plex faces via `next/font/google` with §2 fallback stacks, brief's docblock | ✅ Docblock verbatim; fallbacks exactly `ui-sans-serif, system-ui` / `ui-monospace, SFMono-Regular, Menlo`. |
| Step 4: three groups, own layouts, pages that say plainly what is not built, **no mock product UI** | ✅ Held rigorously. No fake tiles, no seeded table, no empty chart. |
| Step 4: CSP collector logs at `warn` | ✅ `logger.warn(...)` via `@sentinel/observability`. |
| Step 4: `providers.tsx` = TanStack Query + theme and density context | ✅ Both present. Density context is inert (M3) but the brief asked for it. |
| Step 5: `"test:e2e"` in root `package.json` | ✅ Different form (`pnpm --filter @sentinel/web test:e2e`), correctly so — the binary and config live in `apps/web`. |
| Step 6: run it for real | ⚠️ **Partial and honestly reported.** Dev/build/E2E all run; **no human has looked at the page.** Stated in the report and in three `.claude/` docs. I did not look at it either. |
| Step 7: `pnpm lint && typecheck && test && build`, conventional commit with trailer | ✅ Re-verified green. Both commits carry the `Co-Authored-By: Claude Opus 5` trailer. |
| Ruling 4: no blanket `no-store`, `report-uri /api/csp-report` | ⚖️ **Ruled** — implemented as ruled, and both asserted in the spec rather than only commented. |

**Extra, not asked for:** `(marketing)/layout.tsx`, `src/env.ts`, `src/logger.ts`,
`postcss.config.mjs`, `next-env.d.ts`. Each is forced either by a workspace rule
(`process.env` confinement, `no-console`) or by the toolchain (PostCSS, Next).
**No YAGNI violation found** — nothing is built that nobody asked for.

The one hard miss is `WEB_PORT`. Small and mechanical, so the verdict stays ✅, but
it is a real unimplemented line of the stated interface contract.

---

## Verdict 2 — Task quality: **Approved**

This is the strongest task on the branch so far, and I want to say that plainly
because the rest of this document is a list of complaints.

- **Every load-bearing claim I sampled was true.** I re-measured six independently
  — the `/_next/static` cache-control divergence, Next's own `no-store` on dynamic
  HTML, single Tailwind emission in the *built* stylesheet, the `packages/ui`
  `@source` being load-bearing, `:-moz-focusring` being preflight's only outline
  rule, and self-hosted fonts with zero Google hosts. All six held.
- The nonce is **actually** per-request and **actually** reaches the HTML. That is
  the step between "the pure function is correct" and "the application is
  correct", and it is the step this branch has skipped before.
- The E2E spec asserts the header table against a **real response from a real
  production server with the CSP enforcing**, not a mock. "No console errors"
  under an enforcing `'strict-dynamic'` policy is a genuinely strong assertion.
- The implementer ran a **negative control** on the `@source` directives — deleting
  them and confirming what disappeared — rather than asserting that the config it
  wrote was the reason things worked. That method caught one of its own false
  comments.
- All four Task 12 carry-forwards are handled, and I verified three of them in the
  emitted CSS rather than in the source.
- Vitest routing is correct and I confirmed execution, not just a green exit.

Approval is not unconditional: **C1 and C2 are false statements that should be
corrected before this task closes**, and they are exactly the class of defect this
branch keeps producing. Neither breaks running code.

---

## Findings

### Critical

**C1 — `apps/web/app/providers.tsx:9` cites the wrong section of `design-system.md`.**

```ts
/** design-system.md §4 — row height, padding and font size move together. */
export type Density = 'comfortable' | 'compact' | 'dense';
```

`design-system.md` §4 is **"Signature element — the severity spine"**. Density is
**§5, "Layout and density"**, which is where the quoted sentence actually lives
("Density changes row height, padding, and font size together"). Verified against
the file's heading list.

Why it matters: this is the fifth false claim in a task that already caught four,
and it is the same failure mode — a citation written from memory of what a section
ought to be numbered. A reader who follows it lands on the severity spine and
either wastes time or concludes the density modes were never specified. One
character to fix.

**C2 — `.claude/security/transport-and-headers.md` §3 states a false reason for the
`report-uri` divergence.**

The sentence added by this diff:

> `report-uri` sends a cross-origin POST the API's CORS policy would not accept, so
> a report aimed across origins simply never arrives.

Both halves are wrong.

1. **CSP violation reports are not CORS-gated.** The user agent sends the report as
   a fire-and-forget POST and discards the response; there is no preflight and no
   `Access-Control-Allow-Origin` check standing between the browser and the
   collector. Cross-origin `report-uri` is the *normal* deployment — it is how
   every hosted CSP reporting service and Sentry's security endpoint work. A report
   aimed at another origin arrives fine.
2. **The API has no CORS policy to refuse anything.** `grep` for
   `enableCors`/`cors` across `apps/api/src` returns nothing, and
   `transport-and-headers.md` §4 itself still describes CORS as Designed only. The
   sentence invents a control that does not exist and then reasons from it.

This matters more than a typo because it is written into the *security*
documentation as the justification for a security-relevant divergence. The
divergence itself is right (Ruling 4), and `src/security-headers.ts` gives two
sound reasons for it — the API's collector 404s, and a same-origin collector has
fewer dependencies. The document should say those and drop the CORS claim. Note it
also omits the third real reason, which would have survived scrutiny: a
cross-origin `report-uri` ships this origin's `document-uri` values to a different
service.

### Important

**I1 — `WEB_PORT` is validated and then ignored** (`apps/web/package.json:7-10`,
`apps/web/src/env.ts:18`, `apps/web/playwright.config.ts:23,29`).

The brief's interface contract says "Produces: a Next.js app on `WEB_PORT`".
`webEnvSchema` parses it, `env.ts` loads it, and nothing reads it: `next dev` /
`next start` are invoked with no `-p`, so the app binds Next's default 3000, and
Playwright hardcodes `http://localhost:3000` in two places. Setting
`WEB_PORT=3100` in `.env` validates cleanly and changes nothing. A config value
that lies is worse than no config value, and this is the first thing someone hits
running the web app and the API side by side on a busy machine. Fix:
`next start -p $WEB_PORT` (and dev likewise) plus a `baseURL` derived from it.

**I2 — `apps/web/app/api/csp-report/route.ts:57` reads an unbounded request body.**

`await request.text()` buffers the entire POST body into memory before any
validation, on an endpoint that is unauthenticated, covered by no rate limiter
(the API's limiter is on the other origin), and whose URL is published to every
browser in the world inside the CSP header.

Measured: a **20 MB** body was accepted and buffered, returning 204 in 99 ms. Next
App Router route handlers have no default body-size limit — the old
`api.bodyParser.sizeLimit` was Pages Router only.

The per-field `.max()` caps are applied *after* the whole body is already in
memory, so they do not help. The docblock's framing — "`blocked-uri` is capped
because a `data:` URI arrives here in full" — reads as if size is handled; it is
handled for the log line, not for the socket. Fix: reject on `Content-Length`
above a few KB (or read through a capped stream) before calling `text()`.

**I3 — the CSP-report schema logs fields that will carry credentials in Phase 2,
and a comment says otherwise** (`route.ts:26-30`).

> Every field kept here is a URL, a directive name, a policy string or a line
> number — **none of them a credential**

`document-uri` and `referrer` are logged verbatim. `frontend.md` §1 and
`page-map.md` both commit `(auth)` to `/invitations/[token]`, plus
`/reset-password` and `/verify-email`, which conventionally carry a token in the
query string. Browsers strip the fragment from `document-uri` — not the path and
not the query. The moment Phase 2 lands, a single CSP violation on an invitation
page writes a live invitation token into the logs, violating CLAUDE.md rule 6
("Never log … tokens").

Today the claim is vacuously true because no such route exists, which is precisely
why it is dangerous: it is a comment that tells the next reader not to re-examine
this. Either reduce `document-uri`/`referrer` to origin + route pattern before
logging, or replace the comment with an explicit "this becomes unsafe when
token-bearing URLs ship — Phase 2 owes a redaction here".

**I4 — the E2E test for the CSP collector would still pass if the collector were
deleted** (`apps/web/e2e/smoke.spec.ts:72-84`).

The route returns **204 for every possible input**: malformed JSON, schema
failure, and success all take the same exit. The test posts a valid report and
asserts `204`, so it cannot distinguish a working collector from a handler whose
entire body is `return new NextResponse(null, { status: 204 })`, nor from a Zod
schema that rejects everything.

Everything the route actually does — parse, validate, strip unknown keys, emit
exactly one `warn` line of the right shape — is untested at any layer; there is no
unit spec for the route at all. Cheap fix: a unit spec against the exported `POST`
with the logger stubbed, asserting (a) a valid report produces one `warn` call
whose payload contains the known fields and **not** an injected unknown key, and
(b) garbage produces no log call. That also pins the `.strip()` behaviour the
docblock leans on.

**I5 — `pnpm-workspace.yaml:22-32` punches ten holes in pnpm's release-cooldown
control, uncommented, in a security product.**

`minimumReleaseAgeExclude` exempts `next@16.3.2` and its nine `@next/swc-*`
platform binaries from pnpm's minimum-release-age check — the supply-chain control
that refuses freshly published packages, which exists because a compromised release
is most dangerous in its first hours. Every other block in this file carries a
comment explaining exactly why each exemption was granted. This one has none.

The report's defence — "written by pnpm itself during `pnpm install`, not by me" —
is not a defence: an interactive tool wrote it because someone accepted the prompt,
and it is now committed policy. CLAUDE.md's documentation rule covers security
controls; this is one, and it shipped undocumented. At minimum it needs the same
style of comment as `allowBuilds`. Worth an explicit ruling on whether bypassing
the cooldown for a same-day framework release is acceptable here at all.

**I6 — no `eslint-plugin-react` / `eslint-plugin-react-hooks` anywhere, now that
React application code exists** (gap named by the implementer; verdict requested).

`grep -n react eslint.config.js` returns nothing. `apps/web/app/providers.tsx`
contains three hooks with dependency arrays and a lazy `useState` initialiser, and
nothing in the toolchain checks any of it. I read the file: the deps are
**correct** today (`[theme]`, `[density]`, `[theme, density]`;
`setTheme`/`setDensity` are `useState` setters and stable). So this is not a
present bug — it is a missing guard at the exact moment the repo acquired the code
it guards, and hook-dependency bugs are the most common React defect class.

**I rate this Important, not Minor**, and the reason is where it is recorded, not
the rule's absence. `roadmap.md`'s "Known outstanding" list captures the E2E gap
and the missing `pnpm dev`, but **not this one**; it lives only in the gitignored
`.superpowers/` ledger, and the roadmap exists precisely so a resuming session
does not have to read that. Add the plugins in Task 14/16 — and record the gap in
`roadmap.md` now.

**I7 — CI has never rendered a page** (gap named by the implementer; verdict
requested).

`.github/workflows/ci.yml` runs typecheck, `pnpm test`, `pnpm test:integration`
and `pnpm build`. There is no browser install and no `pnpm test:e2e`. Everything
that distinguishes this task from the previous twelve — that a browser executes
this code — is verified on exactly one developer's Windows machine and nowhere
else. The five Playwright tests are the only assertions covering the nonce
reaching the HTML, the CSP not breaking the page, and the header table on a real
response. If one regresses, CI stays green.

I agree with deferring the *edit* to Task 14 (CI is that task's file and a
collision would be worse), and it is properly recorded in `roadmap.md`. But the
severity is Important, not Minor: this is the difference between "the security
control is tested" and "the security control was tested once, locally, in August".
Task 14 should treat it as a required deliverable.

### Minor

**M1 — `next-env.d.ts` is tracked and churns** (gap named by the implementer;
verdict requested). Confirmed tracked. I tested the consequence that would have
made this Important and it does **not** hold: with `apps/web/.next` deleted
entirely, `tsc --noEmit --incremental false` exits 0 and the two
`import "./.next/types/…"` lines produce no error, so a clean-clone CI typecheck
is safe. That leaves spurious `git status` noise when a developer alternates
`next dev` and `next build`. **Minor.** The proposed fix (gitignore +
`git rm --cached`) is right and costs one line; it can ride along with a later
commit. `.prettierignore` already covers it.

**M2 — `(auth)/layout.tsx` renders for no route** (gap named by the implementer).
The brief asked for it explicitly, and the file documents its own unreachability
in a docblock that is accurate. Not a defect. Recording it only so the ruling is
on file: **keep it.**

**M3 — the appearance context is a seam nothing consumes.** Confirmed:
`data-density` appears zero times in `packages/ui/src/tokens.css` and zero times
in the built stylesheet. `--row-height-{comfortable,compact,dense}` exist as bare
tokens but no `[data-density]` selector keys off them, so `setDensity` changes an
attribute nothing reads. The report says exactly this and the brief asked for the
context. No action; noted so nobody later mistakes it for working density
switching.

**M4 — in report-only mode a client can supply its own `Content-Security-Policy`
request header** (`apps/web/proxy.ts:53`). The proxy `set`s only the header name it
is actually sending, so when `enforceCsp` is false it overwrites
`Content-Security-Policy-Report-Only` but leaves any client-supplied
`Content-Security-Policy` request header intact for Next to read a nonce from.
Report-only is development-only, so there is nothing to bypass, and the enforcing
path overwrites correctly. One extra `requestHeaders.delete()` for the other name
would close it permanently.

**M5 — the "no console errors" assertion has a small race**
(`e2e/smoke.spec.ts:8-10`). `errors` is read immediately after the `h1` becomes
visible; a CSP violation from a chunk that loads after first paint could land
after the assertion. `await page.waitForLoadState('networkidle')` before the check
would make the strongest assertion in this suite deterministic.

**M6 — `transport-and-headers.md` §3's log sample is labelled "against the running
dev server"** but shows a JSON line, while `src/logger.ts` sets
`pretty: APP_ENV === 'development'` — the dev server would print the pretty form.
The report's own §5 shows the pretty line for dev and attributes the JSON line to
`next start`. One of the two labels is loose. Cosmetic, but it is a provenance
label on captured output, and provenance labels are what this branch keeps getting
wrong.

**M7 — `roadmap.md` says "Tasks 1–13 are complete (13 pending its adversarial
review)".** The parenthetical is honest, but the heading sentence states a
completion this review had not granted when it was written. Prefer "Tasks 1–12
complete; 13 implemented, pending review" until the review lands.

---

## Things I checked and found genuinely correct

Recorded for calibration, not padding.

- The three documented divergences from `apps/api`'s middleware are each
  **asserted in the spec**, not merely commented — including a negative assertion
  that `Cache-Control` is absent. That is the right way to make a divergence
  survive contact with a future editor.
- `'strict-dynamic'` does what the code assumes: all 16 script tags in the emitted
  HTML carry the nonce, and no chunk is loaded by an un-nonced script.
- `style-src 'self' 'nonce-…'` with no `'unsafe-inline'` is safe here — I checked
  the rendered HTML for inline `<style>` tags (0) and `style="…"` attributes (0),
  the latter being the case that would silently break via `style-src-attr`.
- The `x-nonce` request header is `set`, not appended, so a client cannot inject it.
- `globals.css` correctly imports `@sentinel/ui/tokens.css` **instead of**
  `tailwindcss`, and the built CSS proves single emission.
- Every arbitrary-value utility pairs `text-[length:var(--text-*)]` with an
  explicit `leading-[var(--leading-*)]`, and the bare `text-sm` utility is never
  used in `apps/web`. Carry-forward (c3) is genuinely handled, not merely claimed.
- `next.config.ts`'s `agentRules: false` is a good call, well argued, and the
  useful content of the file Next was generating is preserved as a comment.
- The refusal to add `@testing-library/react` as an unused devDependency, while
  keeping the carry-forward live in the vitest config's comment, is the right
  reading of that constraint.
- `eslint.config.js`'s corrected comment about flat-config glob scoping is
  accurate, and the fix chosen (rely on `apps/web/tsconfig.json` including
  `**/*.ts` so config files get *type-aware* linting) is better than widening the
  glob would have been.
