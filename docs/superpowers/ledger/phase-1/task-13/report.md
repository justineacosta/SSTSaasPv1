# Task 13 report — `apps/web`, the Next.js App Router shell

**Status: Implemented, with four named divergences from the brief and seven named gaps.**

| | |
|---|---|
| Branch | `feat/phase-1-foundation` |
| Base | `8478963` |
| Commits | `594687d` feat(web): Next.js App Router shell with tokens, fonts, and CSP · `6d97bb5` docs(web): tighten proxy.ts to claims that were actually measured |
| Tree | clean at `6d97bb5` |
| Toolchain | Node v26.7.0 · pnpm 11.5.0 · **Next 16.3.2** · React 19.2 · Tailwind 4.3.3 · Playwright 1.62 |

Everything below stated as fact was run. Where a claim is inference rather than observation, it
says so. Three comments I wrote during this task turned out to be false when I went to check
them; all three are in §7 rather than quietly deleted, because the pattern matters more than
the individual fixes.

---

## 1. What was built, file by file

### Security headers — the testable core

**`apps/web/src/security-headers.ts`** — `buildSecurityHeaders(nonce, enforceCsp)`, pure, no
Next import, no I/O. Produces the `transport-and-headers.md` §2 table and the §3 nonce-based
policy. Shared by the proxy and by its own unit spec, which is the entire point of extracting
it. Carries the three deliberate divergences from `apps/api`'s middleware as a docblock, each
with a matching assertion in the spec:

1. **No blanket `Cache-Control: no-store`.** The API's justification ("serves nothing
   cacheable") does not hold on an origin that also serves `/_next/static/**`. Measured: those
   assets answer `Cache-Control: public, max-age=31536000, immutable`, and a blanket `no-store`
   from the proxy would throw that away. Measured on the other side too: Next already sends
   `private, no-cache, no-store, max-age=0, must-revalidate` on the HTML, so the responses that
   will one day carry tenant data are covered without this function touching the header.
2. **`report-uri /api/csp-report`** — this origin's own collector. The API's
   `/api/v1/csp-report` still does not exist (`transport-and-headers.md` §3 says so), and a
   same-origin collector does not depend on the API being reachable or on its rate limiter
   having an opinion about a browser-generated POST.
3. **No `Cross-Origin-Embedder-Policy: require-corp`.** §2 scopes COEP to "the app origin".
   This shell embeds no cross-origin subresource, and COEP blocks anything that does not opt in
   with CORP/CORS — a cost to pay when there is something to protect (the evidence viewer,
   Phase 5), not before.

**`apps/web/src/security-headers.spec.ts`** — the brief's six tests verbatim, plus three I
added: `Cache-Control` is absent, `report-uri` points at this origin, and the report-only
policy text is identical to the enforcing one. Routes to the `unit` Vitest project (§5).

**`apps/web/proxy.ts`** — mints a nonce per request with `crypto.randomUUID()`, applies the
table to the response, and forwards both `x-nonce` and the CSP header on the *request* so Next
can stamp its own inline bootstrap scripts. Note Next reads the CSP request header, not
`x-nonce` — `x-nonce` is the seam for a future `next/script`, and nothing reads it today.

### Configuration and logging seams

**`apps/web/src/env.ts`** — the single door between `apps/web` and `process.env`. Calls
`loadEnv(webEnvSchema)` and exports `env` plus `enforceCsp = env.APP_ENV !== 'development'`,
derived exactly once, same rule and same derivation as the API's `CSP_ENFORCE` provider.

**`apps/web/src/logger.ts`** — `createLogger({ service: 'web', level: env.LOG_LEVEL, pretty:
APP_ENV === 'development', silent: APP_ENV === 'test' })`. Same shape as the API's logger.

### App shell

**`app/layout.tsx`** — `<html>` carrying the three next/font variable classes, `<body>` on
tokens, `metadata` with `robots: { index: false, follow: false }` (a pre-release shell should
not be indexed), `viewport.colorScheme: 'light dark'`, and `export const dynamic =
'force-dynamic'` with the full reasoning (§2b).

**`app/fonts.ts`** — IBM Plex Sans (400/500), Sans Condensed (600), Mono (400/500) through
`next/font/google`, each with the `design-system.md` §2 fallback stack, exported as one
`fontVariables` class string. Carries the brief's docblock verbatim.

**`app/globals.css`** — imports `@sentinel/ui/tokens.css` and *nothing else* (no second
`@import 'tailwindcss'`), three `@source` directives, body typography from tokens, a
`.font-display` class for the condensed cut, and `code/kbd/pre/samp` on the mono face.

**`app/providers.tsx`** — `'use client'`. TanStack Query client created inside `useState` (a
module-scope client on the server would share cache across requests), 30s `staleTime`,
`retry: 1`, `mutations: { retry: 0 }`. Plus an appearance context (`theme`:
light/dark/system, `density`: comfortable/compact/dense) applied to `documentElement` in
effects; `system` removes the attribute so `packages/ui`'s `prefers-color-scheme` block wins.
**Not persisted** — that needs a render-blocking inline script carrying the nonce, and a
half-built persistence that flashes the wrong theme is worse than none.

### Routes

| File | URL | What it says |
|---|---|---|
| `app/(marketing)/layout.tsx` | — | Header/main/footer shell |
| `app/(marketing)/page.tsx` | `/` | What Sentinel is, the six-step workflow, why the UI is quiet. An `Alert` states outright that nothing on the page is a demo. |
| `app/(auth)/layout.tsx` | — | Centred column. **No route renders through it yet** — `(auth)` is Phase 2. |
| `app/(app)/layout.tsx` | — | Bare column. No fake sidebar. |
| `app/(app)/dashboard/page.tsx` | `/dashboard` | "The product is not built yet", names Phase 1, lists what actually exists. No mock product UI. |
| `app/api/health/route.ts` | `/api/health` | `{"status":"ok"}`, `force-dynamic`, `no-store`. Checks nothing else on purpose. |
| `app/api/csp-report/route.ts` | `/api/csp-report` | Zod-validated collector, unknown keys stripped, one `warn` line, always 204. |

### Config and harness

`next.config.ts` · `tsconfig.json` · `postcss.config.mjs` · `playwright.config.ts` ·
`e2e/smoke.spec.ts` (the brief's three tests plus two I added: the full header table on a real
response with a nonce that differs between two requests, and a 204 from the collector).

### Files outside `apps/web`

- `package.json` — added `"test:e2e"`.
- `eslint.config.js` — corrected a false comment and added two `files` entries (§6).
- `.prettierignore` — added `apps/web/next-env.d.ts` (generated; Next rewrites it).
- `pnpm-workspace.yaml` — `minimumReleaseAgeExclude` entries **written by pnpm itself** during
  `pnpm install`, not by me.
- Five `.claude/` documents (§8).

---

## 2. The four divergences from the brief

### (a) `proxy.ts`, not `middleware.ts` — and yes, this makes the brief's filename stale

**This is a plan defect and I am flagging it rather than papering over it.** The brief names
`apps/web/middleware.ts`. On Next 16.3.2 that filename is deprecated.

I did not take this from documentation alone. I wrote `middleware.ts` first, exactly as the
brief said, and ran the build. Verbatim from that build's output:

```
▲ Next.js 16.3.2 (Turbopack)
✓ Running next.config.ts took 21ms

⚠ The "middleware" file convention is deprecated. Please use "proxy" instead.

  To migrate automatically, run:
  npx @next/codemod@canary middleware-to-proxy .

  Learn more: https://nextjs.org/docs/messages/middleware-to-proxy
```

Confirmed in Next's own source under `apps/web/node_modules/next/dist/`:

- `lib/constants.js:287-290` — `MIDDLEWARE_FILENAME = 'middleware'`, `PROXY_FILENAME = 'proxy'`.
- `build/index.js:724` — having both files present is a hard error.
- `build/index.js:730` — the `warnOnce` printed above.
- `build/analysis/get-page-static-info.js:606-620` — a route-segment `runtime` export in a
  proxy file throws `E1031` with the message **"Proxy always runs on Node.js runtime."**

That last point changed one of your dispatch assumptions in my favour. You wrote that
middleware stays on Edge and asked me to solve and document how env behaves there. **Proxy is
Node**, so `process.env` is an ordinary object and `loadEnv(webEnvSchema)` works exactly as it
does in `apps/api` — no Edge inlining caveat exists to solve. Confirmed by watching the derived
flag change on live responses rather than by reasoning: `APP_ENV=development` produced
`content-security-policy-report-only`, `APP_ENV=test` produced `content-security-policy`. That
is only possible if `loadEnv` read a real environment from inside the proxy bundle.

`middleware.ts` would still work today. I chose not to ship the first file a browser touches on
a convention Next tells us to stop using. **Your ruling is wanted on whether the plan document
should be corrected**, since Tasks 14–16 may reference the same filename.

### (b) Every HTML route is `force-dynamic` — this contradicts `frontend.md` §2

The most consequential decision I made, and the brief did not anticipate it.

`frontend.md` §2 makes marketing Static with ISR. That is incompatible with the §3 nonce CSP,
and structurally so: Next stamps the nonce onto its own inline bootstrap scripts by reading the
CSP header off the *request*, and a page prerendered at build time was never rendered for a
request. Measured, not assumed — with `force-dynamic` absent, `/` built as `○ (Static)` and:

```
$ grep -o 'nonce="[^"]*"' .next/server/app/index.html | head
                                  (no output)
$ grep -o '<script[^>]*>' .next/server/app/index.html | wc -l
16
```

Nine of those sixteen are inline. Because `script-src` carries `'strict-dynamic'`, an enforcing
policy blocks every un-nonced inline script *and* every chunk they would have loaded — the page
ships as dead HTML. With `force-dynamic` set, against a live server:

```
=== inline <script> without nonce ===
0
```

The choice is a strict CSP or a prerendered marketing page. `'unsafe-inline'` is the only other
way to make prerendering work and it is banned. This is a security product, so Phase 1 takes
the CSP. The cost is real — no ISR, no CDN-cached HTML, a server render per request — and it is
written up in `frontend.md` §2 under a new "Where the table is not true today" heading, in
`app/layout.tsx`, and in the roadmap.

### (c) `(app)/page.tsx` → `(app)/dashboard/page.tsx`

The brief lists both `app/(marketing)/page.tsx` and `app/(app)/page.tsx`. Both resolve to `/`,
and Next refuses to build two pages on one path. `/dashboard` is the route `page-map.md` already
assigns to this group's overview. `page-map.md` now says explicitly that this placeholder is
*not* the Phase 5 `/dashboard` it commits to.

### (d) Extensionless imports inside `apps/web`

The workspace convention is `nodenext` ESM with explicit `./foo.js`. Turbopack does not perform
the `.js` → `.ts` substitution. First build, verbatim:

```
./apps/web/middleware.ts:2:1
Error: Module not found: Can't resolve './src/env.js'
```

I tried `experimental.extensionAlias` first. Next accepted it and printed it as an active
experiment — and the build still failed identically, because `extensionAlias` is read only at
`next/dist/build/webpack-config.js:591` and Next 16 builds with Turbopack. So `apps/web` uses
extensionless specifiers, with `moduleResolution: "bundler"` in its tsconfig to match. The one
exception is `src/security-headers.spec.ts`, which keeps the brief's `./security-headers.js`
because Vitest runs it through Vite, which does substitute. Written up in `next.config.ts`.

---

## 3. Answering (b) — files the brief did not list, and the one it listed that is absent

| File | Verdict |
|---|---|
| `apps/web/src/env.ts` | **Forced by the architecture.** `enforceCsp` must be derived once from `APP_ENV` (your dispatch said so explicitly), and `process.env` may only be read through `packages/config` (lint-enforced). Something in `apps/web` has to be that door; this is it. It also gives the proxy and route handlers one place to fail loudly on misconfiguration. |
| `apps/web/src/logger.ts` | **Forced by two brief requirements colliding.** The brief requires the CSP collector to "log at `warn`", and `no-console` is an error workspace-wide, so the collector must use `@sentinel/observability`. Constructing the logger inline in the route handler would put env-reading and logger config in a request handler; this keeps it in one module, matching the API's `ConfigModule`. |
| `app/(marketing)/layout.tsx` | **Consistency with `frontend.md` §1**, which says route groups exist so each has its own layout — and the brief lists layouts for the other two groups. Omitting only marketing's would have been the odd choice. Low risk: it is a header/main/footer shell. |
| `app/(app)/dashboard/page.tsx` | **Replaces the brief's `app/(app)/page.tsx`, which cannot exist.** See §2c — it collides with `(marketing)/page.tsx` on `/` and Next refuses to build. Content is exactly what the brief asked for: says the product is not built, names the current phase, no mock UI. |
| `app/(app)/page.tsx` | **Absent, deliberately.** Same reason. |

Two further unlisted files, both plumbing the brief implies rather than names:
`postcss.config.mjs` (Tailwind v4 is a PostCSS plugin; without it no CSS is emitted at all) and
`next-env.d.ts` (generated by Next — see §9.2, where I flag it as a defect).

---

## 4. Answering (c) — the four Task 12 carry-forwards

### (c1) Single `@import 'tailwindcss'` — done

`app/globals.css` line 12 is `@import '@sentinel/ui/tokens.css';` and there is no
`@import 'tailwindcss'` anywhere in `apps/web`. Verified by counting a preflight-only string in
the built stylesheet — if Tailwind were emitted twice this would be 2:

```
$ grep -oc 'tab-size:4' .next/static/chunks/451pm4kab04a8.css
1
```

### (c2) Arbitrary-value utilities only — done, **and here is the grep you asked for**

Every token reference in `apps/web` is an arbitrary-value utility. Against the fresh build at
`6d97bb5` (`CSS FILE: .next/static/chunks/451pm4kab04a8.css`):

```
$ for u in ...; do printf '%-45s %s\n' "$u" "$(grep -coF -- "$u" "$CSS")"; done
text-\[length\:var\(--text-display\)\]        1
leading-\[var\(--leading-display\)\]          1
text-\[length\:var\(--text-sm\)\]             1
leading-\[var\(--leading-sm\)\]               1
bg-\[var\(--color-surface\)\]                 1
sm\:grid-cols-2                               1
tracking-\[0\.06em\]                          1
rounded-\[var\(--radius-card\)\]              1
```

The last line is the load-bearing one: `rounded-[var(--radius-card)]` appears **only** in
`packages/ui/src/components/Card.tsx`, never in `apps/web`.

I also ran the negative control, because "it works" and "the `@source` lines are why it works"
are different claims. Rebuilding with all three `@source` directives deleted:

```
text-\[length\:var\(--text-display\)\]        1     <- still present
sm\:grid-cols-2                               1     <- still present
rounded-\[var\(--radius-card\)\]              0     <- MISSING
```

So Tailwind v4's auto-detection *does* reach `apps/web` (it roots at the build's working
directory) and does *not* reach `packages/ui`. Only `@source '../../../packages/ui/src'` is
strictly necessary; the other two are kept so the emitted CSS does not depend on where the build
was invoked from, and the comment in `globals.css` says exactly that. My first version of that
comment claimed all three were required — that was wrong, and this control is what caught it.

### (c3) `--text-sm` / `--leading-sm` pairing — done

Every use is paired explicitly. Confirmed in the built CSS that the two are separate utilities
and that Tailwind's own `text-sm` still carries its own ratio, exactly as `design-system.md` §7
describes:

```
.text-sm{font-size:var(--text-sm);line-height:var(--tw-leading,var(--text-sm--line-height))}
.text-\[length\:var\(--text-sm\)\]{font-size:var(--text-sm)}
.leading-\[var\(--leading-sm\)\]{--tw-leading:var(--leading-sm);line-height:var(--leading-sm)}
```

`apps/web` never uses the bare `text-sm` utility.

### (c4) `@testing-library/react` devDependency — deliberately NOT added

```
$ grep -rn "@testing-library" apps/web/package.json apps/web/src apps/web/app
no reference anywhere in apps/web
$ find apps/web/src apps/web/e2e -name "*.spec.*"
apps/web/src/security-headers.spec.ts
apps/web/e2e/smoke.spec.ts
```

`apps/web` has no `.spec.tsx` and no component test, so nothing imports it. Adding an unused
devDependency to satisfy a carry-forward whose trigger has not fired would be cargo cult. **The
carry-forward remains live**: the first `apps/web/src/**/*.spec.tsx` anyone writes must add
`@testing-library/react` to `apps/web`'s devDependencies, because the shared `setupFiles` path
resolves its own imports against `packages/ui`'s `node_modules` and that does not extend to the
spec's imports.

---

## 5. Answering (d) — Playwright and Step 6

### Browsers installed — yes, nothing was blocked

`pnpm exec playwright install chromium` succeeded: Chrome for Testing 151.0.7922.34 (191.8 MiB)
and Chrome Headless Shell (114.5 MiB) downloaded to
`C:\Users\Sam\AppData\Local\ms-playwright\`.

### `pnpm test:e2e` — runs, 5 passed

Re-run just now for this report:

```
$ pnpm test:e2e
$ pnpm --filter @sentinel/web test:e2e
$ playwright test
[WebServer] $ dotenv -e ../../.env -v NODE_ENV=production -- next build
[WebServer] $ dotenv -e ../../.env -v NODE_ENV=production -v APP_ENV=test -- next start

Running 5 tests using 5 workers

  ok 4 [chromium] › e2e\smoke.spec.ts:72:1 › the CSP report collector accepts a violation report (123ms)
  ok 5 [chromium] › e2e\smoke.spec.ts:21:1 › the page does not scroll horizontally at a narrow viewport (458ms)
  ok 2 [chromium] › e2e\smoke.spec.ts:3:1 › the marketing page renders with no console errors (527ms)
  ok 3 [chromium] › e2e\smoke.spec.ts:36:1 › a real response carries the security header table and a fresh CSP nonce (507ms)
  ok 1 [chromium] › e2e\smoke.spec.ts:13:1 › renders in both colour schemes (627ms)

  5 passed (8.0s)
```

Playwright runs against a **production build with the CSP enforcing** (`start:e2e` pins
`APP_ENV=test`), following the API's stated principle that a policy only ever asserted in
report-only mode is a policy no test has watched block anything.

### Step 6, verified over HTTP

Dev server (`pnpm --filter @sentinel/web dev`):

```
▲ Next.js 16.3.2 (Turbopack)
- Local:         http://localhost:3000
✓ Ready in 299ms
```

```
=== GET / ===
HTTP/1.1 200 OK
content-security-policy-report-only: default-src 'self'; script-src 'self' 'nonce-MWNiNjVmZTctMThjNC00OTlhLWIxMTctZGNhMDI5MDVkYzZm' 'strict-dynamic'; style-src 'self' 'nonce-...'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'self'; object-src 'none'; upgrade-insecure-requests; report-uri /api/csp-report
cross-origin-opener-policy: same-origin
cross-origin-resource-policy: same-origin
permissions-policy: camera=(), microphone=(), geolocation=(), payment=()
referrer-policy: strict-origin-when-cross-origin
strict-transport-security: max-age=31536000; includeSubDomains; preload
x-content-type-options: nosniff
x-frame-options: DENY

=== h1 ===                              Security testing for assets you own, and have proved you own.
=== inline <script> without nonce ===   0
=== GET /dashboard h1 ===               The product is not built yet.
=== GET /api/health ===                 {"status":"ok"} [200]
=== GET /nope ===                       404
=== POST /api/csp-report ===            204
```

And the collector's log line, proving `@sentinel/observability` works inside Next's server:

```
[13:52:10.947] WARN: Content Security Policy violation
    service: "web"
    cspReport: {
      "document-uri": "http://localhost:3000/",
      "violated-directive": "script-src",
      "blocked-uri": "inline"
    }
```

Note `content-security-policy-report-only` in dev vs `content-security-policy` under
`APP_ENV=test` — the `enforceCsp` derivation observably works in both directions.

Fonts, verified in the built CSS rather than by eye:

```
@font-face{font-family:IBM Plex Sans;...;src:url(../media/7fea77d1d19108bf...woff2)format("woff2")}
.ibm_plex_sans_..._variable{--font-sans:"IBM Plex Sans", ui-sans-serif, system-ui}
.ibm_plex_sans_condensed_..._variable{--font-condensed:"IBM Plex Sans Condensed", ui-sans-serif, system-ui}
.ibm_plex_mono_..._variable{--font-mono:"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo}

$ grep -c "fonts.gstatic\|fonts.googleapis" <built css>
0
```

Self-hosted under `/_next/static/media`, correct fallback stacks, **zero** references to any
Google host — which is what makes `font-src 'self'` true rather than aspirational.

### Step 6, still owed to a human

**I did not open a browser and look at anything, and I did not write that I did.** What remains
owed:

- **Nobody has judged the typography, spacing, weight, hierarchy or contrast.** I verified IBM
  Plex *loads*; I did not verify the page looks good, or that the display/body/mono split reads
  the way `design-system.md` §2 intends.
- **The OS colour-scheme toggle has not been exercised by hand.** Playwright's
  `emulateMedia({ colorScheme })` asserts the page renders in both; it does not confirm the dark
  palette is legible or that the switch looks right.
- **No non-Chromium browser has loaded this**, and no real mobile device.

---

## 6. Verification — full output, re-run at `6d97bb5` with the Turbo cache cleared

```
$ pnpm lint
...
@sentinel/web:lint: $ eslint .
@sentinel/api:lint: $ eslint src

 Tasks:    14 successful, 14 total
Cached:    0 cached, 14 total
  Time:    12.475s
```

```
$ pnpm typecheck
@sentinel/web:typecheck: $ tsc -p tsconfig.json --noEmit
@sentinel/api:typecheck: $ tsc -p tsconfig.json --noEmit

 Tasks:    14 successful, 14 total
  Time:    4.162s
```

```
$ pnpm test
 ✓  unit  apps/web/src/security-headers.spec.ts (9 tests) 4ms
 Test Files  26 passed (26)
      Tests  287 passed (287)
   Duration  2.38s
```

The spec name is printed with its project tag — `unit` — which is the proof you asked for that
it routed somewhere and actually executed, rather than passing green under `--passWithNoTests`.

```
$ rm -rf apps/web/.next && pnpm build
@sentinel/web:build: $ dotenv -e ../../.env -v NODE_ENV=production -- next build
@sentinel/web:build: ▲ Next.js 16.3.2 (Turbopack)
@sentinel/web:build: ✓ Compiled successfully in 3.1s
@sentinel/web:build:   Running TypeScript ...
@sentinel/web:build:   Finished TypeScript in 1604ms ...
@sentinel/web:build: ✓ Generating static pages using 7 workers (2/2) in 408ms
@sentinel/web:build: Route (app)
@sentinel/web:build: ┌ ƒ /
@sentinel/web:build: ├ ƒ /_not-found
@sentinel/web:build: ├ ƒ /api/csp-report
@sentinel/web:build: ├ ƒ /api/health
@sentinel/web:build: └ ƒ /dashboard
@sentinel/web:build: ƒ Proxy (Middleware)

 Tasks:    8 successful, 8 total
  Time:    8.057s
```

**TDD order was followed.** Step 1's spec was written first and run before the implementation
existed. That failure, verbatim:

```
 FAIL  unit  apps/web/src/security-headers.spec.ts [ apps/web/src/security-headers.spec.ts ]
Error: Cannot find module './security-headers.js' imported from
'E:/GitHub/SSTSaasPv1/apps/web/src/security-headers.spec.ts'

 Test Files  1 failed | 22 passed (23)
```

Also: `pnpm exec prettier --check "apps/web/**/*.{ts,tsx,css,mjs,json}" ".claude/**/*.md"` →
`All matched files use Prettier code style!`

### Brief step status

| Step | Status |
|---|---|
| 1 — failing header test | **Done.** Brief's six tests verbatim + three added. |
| 2 — watch it fail, then implement | **Done.** Failure output above. `middleware.ts` → `proxy.ts` (§2a). |
| 3 — self-hosted fonts | **Done.** Docblock verbatim; self-hosting verified in built CSS. |
| 4 — route groups, pages, CSP collector, providers | **Done**, with `(app)/page.tsx` → `/dashboard` (§2c). |
| 5 — Playwright smoke spec | **Done.** Brief's three tests verbatim + two added. Root `test:e2e` delegates (§8). |
| 6 — run it for real | **Partial.** Dev, build and E2E all run; HTTP-level checks done. Visual confirmation by eye is **not done** and cannot be by me. |
| 7 — verify and commit | **Done.** Brief's commit message used, with four divergences appended. |

---

## 7. `eslint.config.js` — the comment you asked me to check was false

The block for root config files claimed it would cover "a future `apps/web/playwright.config.ts`
(Task 13)". **It does not.** Under flat config a glob with no `/` resolves against the config's
base path and matches one directory level only, so `*.config.ts` never reaches
`apps/web/*.config.ts`. Verified once the file existed:

```
$ eslint --print-config apps/web/playwright.config.ts
no-undef: [0,{"typeof":false}]
no-restricted-properties: [2,{"object":"process","property":"env",...}]
has type-aware rule (no-floating-promises): [2]
globals has process: false
```

`globals has process: false` proves the block did not apply. `no-undef` is off because
typescript-eslint's `eslint-recommended` turns it off, not because that block ran.

The fix is not to widen the glob. `apps/web/tsconfig.json` includes `**/*.ts`, so
`next.config.ts`, `playwright.config.ts`, `proxy.ts` and `e2e/**` are all inside a real tsconfig
project and get **type-aware** linting — strictly better than the fallback. Two real gaps
remained, and I fixed both:

1. `apps/web/postcss.config.mjs` is not TypeScript, so no tsconfig can hold it, and the project
   service refused to parse it: `Parsing error: ... was not found by the project service`. Added
   `'apps/*/postcss.config.mjs'` to that block.
2. `playwright.config.ts` reads `process.env['CI']` for retries/reporter/`reuseExistingServer`
   and tripped `no-restricted-properties`. Added `'apps/*/playwright.config.ts'` to the existing
   test-harness exemption, alongside `**/*.spec.ts` and `apps/api/src/testing/**`, on the same
   rationale already written there: a test harness is not application code, and `CI` is a
   property of the machine, not Sentinel configuration.

The comment now states what is true, names how it was verified, and explains why apps/web's
TypeScript config files need nothing.

**I also proved the no-raw-hex rule actually fires in `apps/web`** — `design-system.md` §7 has
claimed that scope since before `apps/web` existed. A throwaway `apps/web/src/__hex_probe__.tsx`
with an inline `style={{ color: '#ff0000' }}` and a template-literal class holding `#00ff00`:

```
  1:43  error  No raw hex colours — reference a design token custom property instead ...
  1:67  error  No raw hex colours — reference a design token custom property instead ...
✖ 2 problems (2 errors, 0 warnings)
```

Probe deleted.

---

## 8. Three comments I wrote that were false, and what `6d97bb5` corrected

Recorded because this branch's most common defect is exactly this, and I produced four
instances in one task before catching them.

1. **`serverExternalPackages: ['pino', 'pino-pretty']`** — I added it and wrote that bundling
   pino "breaks that resolution". I had not tested it. Commenting it out and rebuilding: the
   collector logged correctly with `pretty: false` *and* with `pretty: true` (a properly
   formatted pretty line). The option was removed as unnecessary, and since pretty demonstrably
   works I switched the logger to `pretty: APP_ENV === 'development'`, matching the API. Both
   files now record the test rather than the assumption.

2. **A global `:focus-visible { outline: 2px solid var(--color-accent) }` in `globals.css`**,
   justified as "Tailwind v4 resets outlines on interactive elements". False — the only outline
   preflight touches is `:-moz-focusring:where(:not(iframe)){outline:auto}`, a Firefox
   normalisation. Worse, the rule was **actively harmful**: it ordered after `packages/ui`,
   whose primitives pair `focus-visible:outline-none` with a token ring, so it would have put an
   outline *and* a ring on every focused Button and Input. Removed, with a comment recording why.

3. **The `@source` comment in `globals.css`** claimed all three directives were required. The
   negative control in §4 (c2) showed only the `packages/ui` one is. Rewritten to the measured
   result.

**Answering question 3 — what `6d97bb5` corrected.** The original `proxy.ts` docblock said Next
"will remove `middleware.ts` in a future major". Nothing I observed says that — the deprecation
notice implies it, which is inference, not measurement. The claim was deleted; the sentence now
stops at what Next actually does (detects both files, errors if both exist). The same commit
*added* evidence to a claim that previously had none: that `loadEnv` reads a real environment
inside the proxy bundle is now backed by the observation that the derived flag changes —
`APP_ENV=development` → `Content-Security-Policy-Report-Only`, `APP_ENV=test` →
`Content-Security-Policy` — which is impossible unless `loadEnv` read the real environment.

---

## 9. Other decisions the brief did not dictate

- **`dotenv -e ../../.env -v NODE_ENV=<x>`** in every script. There is no `apps/web/.env`; the
  repo-root file is shared, matching `apps/api`. `NODE_ENV` is pinned per command because
  `.env` sets `development` and `next build` warned: *"You are using a non-standard NODE_ENV
  value in your environment... strongly advised against."* Verified `-v` overrides the file:
  `NODE_ENV=production APP_ENV=development`.
- **Root `test:e2e` delegates** (`pnpm --filter @sentinel/web test:e2e`) rather than being a
  bare `playwright test` as the brief wrote. `@playwright/test` is an `apps/web` devDependency
  and the config lives there; a bare root invocation resolves neither the binary nor the config.
  `apps/web/package.json` carries the literal `"test:e2e": "playwright test"`.
- **`agentRules: false`.** `next dev` wrote `apps/web/AGENTS.md` and an `apps/web/CLAUDE.md` on
  every run. A second, generated CLAUDE.md nobody wrote or reviews is what this repo's
  documentation rule exists to prevent. Disabled, files deleted, verified they stop being
  regenerated, and the one genuinely useful thing they said is preserved as a comment in
  `next.config.ts` (Next 16 differs from training data; `node_modules/next/dist/docs/`).
- **`playwright.config.ts` targets a production build**, not `next dev`. `next dev` injects
  hot-reload machinery and dev-only React warnings, so "no console errors" would be measuring
  the dev server. It is also the only place where the static/dynamic decision is the real one.
- **A stale `packages/ui/dist` on this machine** had lowercase filenames (`alert.js`) from
  before Task 12's PascalCase rename — Windows' case-insensitive filesystem let `tsc` overwrite
  content without renaming, so `dist/index.js`'s `./components/Alert.js` did not resolve.
  `rm -rf packages/ui/dist` fixed it. **Not a repo defect** (`dist` is gitignored, CI builds
  clean), but it will bite any Windows dev who was on the branch before that rename.
- **Documentation updated in the same change**, per the documentation rule: `frontend.md`
  (status + the new §2 subsection), `transport-and-headers.md` (status now covers both origins;
  §3 corrected — the API's own collector still does not exist), `design-system.md` (status: a
  browser now renders three of eight primitives, and nobody has looked at it; §7's lint claim
  now cites the probe), `page-map.md` (two URLs answer, neither is a shipped route),
  `roadmap.md` (Tasks 1–13 complete pending review; what `apps/web` does and does not do).

---

## 10. NOT DONE — gaps I am naming myself

1. **CI has no E2E stage.** `.github/workflows/ci.yml` neither installs a Playwright browser nor
   runs `pnpm test:e2e`. Everything in §5 was verified on this machine only; **nothing in CI has
   ever rendered a page.** Recorded in the roadmap as Task 14's. I did not touch the workflow
   because CI is Task 14's file and editing it here would collide.
2. **`next-env.d.ts` is committed and churns.** Next rewrites it depending on the last command:
   `next dev` writes `./.next/dev/types/...`, `next build` writes `./.next/types/...`. It
   therefore flips in `git status` every time a developer switches between the two — I hit this
   while gathering evidence for this report. I restored it and left the tree clean, but **the
   correct fix is to gitignore it** (current `create-next-app` does exactly that) and I did not
   make that change, because it surfaced after the commits and I was told not to start new work.
   One `.gitignore` line plus `git rm --cached`. Typecheck passes either way — verified with
   `.next` deleted entirely, so CI's typecheck-before-build ordering is safe.
3. **`(auth)/layout.tsx` renders for no route.** The brief asked for it; there are no `(auth)`
   routes until Phase 2. It is unreachable code today. Documented in the file itself.
4. **No `eslint-plugin-react` / `react-hooks`.** The workspace ESLint config has no React rules,
   so nothing checks hook dependency arrays or JSX correctness in `apps/web` — the first React
   app in the repo. I did not add them; that is a workspace-wide config decision, Task 14/16's.
5. **Root `pnpm dev` still does not exist** and `.claude/development/setup.md` still tells a
   developer to run it. `apps/web` now has a `dev` script but `turbo.json` has no `dev` task.
   Pre-existing, previously logged as a residual, now more visible; noted in the roadmap.
6. **`@types/node` is not declared in `apps/web`.** It resolves from the workspace root, which
   is how `apps/api` also does it. Consistent, but implicit.
7. **`next build` needs network access** for `next/font/google` to fetch IBM Plex. Fine on this
   machine and on GitHub Actions; would fail in an egress-restricted builder.

---

## 11. Things I am unsure about

- **`connect-src 'self'` will need widening in Phase 2.** `API_BASE_URL` is `:3001` in local
  development — a different origin — so the first browser fetch to the API will be blocked.
  Noted in `transport-and-headers.md` §3 so it is not a surprise; not fixed, because widening a
  policy before there is a request to justify it is how a strict policy erodes.
- **`force-dynamic` is right for Phase 1 and probably wrong for Phase 5.** I am confident in the
  measurement and less confident that the eventual fix is the CDN-level split I suggested. It
  deserves an ADR when marketing content actually exists.
- **The appearance context is a seam nothing uses.** No component reads `useAppearance`, no
  toggle exists, and `data-density` is set on an attribute no stylesheet keys off yet.
  Defensible as scaffolding the brief asked for; also fair to call it unexercised code.
- **The `/dashboard` name may confuse later** even with the `page-map.md` note, since Phase 5
  commits the same URL to a real live-metrics view.
- **Whether disabling `agentRules` was the right call.** The content Next generates is genuinely
  useful and would have saved me the middleware/proxy discovery. I traded that against unowned
  generated documentation. Easy to reverse if you disagree.

---
---

# Task 13 — fix report, review round 1

Commit: `21746c5` fix(web): review round 1 — WEB_PORT, CSP-report hardening, false claims
(on top of `594687d` and `6d97bb5`). Range under review was `8478963..6d97bb5`.

Every finding below lists what changed, the covering test, the command, and its real output.
Two findings were ruled no-action by the coordinator (M2, M3) and are untouched.

---

## C1 — wrong `.claude/` section citation, and the audit behind it

**Changed.** `apps/web/app/providers.tsx:9` cited `design-system.md` §4 for density. §4 is
"Signature element — the severity spine"; density is §5, "Layout and density", which is where
the sentence I paraphrased actually lives ("Density changes row height, padding, and font size
together").

The coordinator asked me to audit every section citation in the diff before fixing this one.
I did, and **it found a second instance of the same error**:

```
$ git diff 8478963..HEAD --name-only | grep -v pnpm-lock | while read f; do
    [ -f "$f" ] && grep -Hno "§[0-9]\+" "$f"; done | sort -u
```

68 citations across 15 files. I dumped the `^## ` heading list of every cited document
(`design-system.md`, `frontend.md`, `transport-and-headers.md`, `environments.md`,
`page-map.md`, `coding-standards.md`) and checked each citation line against it.

| Verdict | Count |
|---|---|
| Correct | 66 |
| **Wrong — density cited as §4** | **2** |

The second was `.claude/ui-ux/design-system.md:18`, in the status block *I added last round*:
"the §4 density modes are wired to a context that nothing reads". Same error, same habit, in
the same task. Both are now §5.

Everything else held, including the ones most likely to be wrong: `frontend.md` §4 forms / §5
permissions / §6 required states / §7 performance / §8 structure in my status block,
`transport-and-headers.md` §1/§4/§5/§6, `environments.md` §4, `coding-standards.md` §6.

```
$ sed -n '9p' "apps/web/app/providers.tsx"
/** design-system.md §5 — row height, padding and font size move together. */
$ sed -n '18p' .claude/ui-ux/design-system.md
> hierarchy, spacing, weight or contrast, and the §5 density modes are wired to a context
$ sed -n '147p' .claude/ui-ux/design-system.md
## 5. Layout and density
```

**Covering test:** none is possible — a prose cross-reference has no runtime behaviour. The
covering *mechanism* is the audit above, which is repeatable as a one-liner and which I would
now run before any commit that adds a citation. Recorded here because "I checked it this time"
is not a control.

---

## C2 — invented CORS mechanism in the security documentation

**Changed.** The sentence I added to `transport-and-headers.md` §3 —

> `report-uri` sends a cross-origin POST the API's CORS policy would not accept, so a report
> aimed across origins simply never arrives.

— is wrong twice, and the reviewer is right on both counts. CSP violation reports are not
CORS-gated (the UA sends a fire-and-forget POST, no preflight, response discarded), and
`apps/api` has no CORS configuration at all. I re-confirmed the second half rather than taking
it on faith:

```
$ grep -rn "enableCors\|cors" apps/api/src --include=*.ts
(no output)
```

The divergence stands — same-origin collection is still the right call. The paragraph now
gives the two reasons that survive scrutiny, plus the third the reviewer noted I had missed:

1. The API's collector does not exist, so a report aimed at it would 404 (this document says so
   two sentences earlier).
2. A report carries `document-uri` and `referrer` — **our own** URLs, which from Phase 2 name
   routes and identify tenants — and sending those to a different service is a disclosure
   decision, not a routing detail.
3. Same-origin collection depends on nothing else being reachable.

And it now states the correction explicitly, so nobody re-derives the wrong reason:

> **A cross-origin `report-uri` would have worked.** Saying so explicitly because an earlier
> version of this paragraph claimed the opposite — that CORS would have blocked it — and that
> was wrong twice over. […] The divergence is a deliberate choice between two options that both
> work, not a workaround for a control that does not exist.

I deliberately did not invent a replacement mechanism. Reasons 1 and 3 are checkable facts
about this repository; reason 2 is a policy statement, not a claim about browser behaviour.

**Covering test:** none possible (documentation). Verified by grep for the removed claim and
by reading §4, which still describes CORS as Designed only.

---

## I1 — `WEB_PORT` now governs the port

**Changed.** `apps/web/scripts/next-on-web-port.ts` (new), `apps/web/package.json`,
`apps/web/playwright.config.ts`.

The obvious fix does not work, and I checked before writing it. `next start -p $WEB_PORT` in a
package.json script relies on the script runner expanding a shell variable, and pnpm on Windows
does not:

```
$ WEB_PORT=3100 pnpm run __probe        # probe script: node -p "..." $WEB_PORT
$ node -p "process.argv.slice(1).join(0)" $WEB_PORT
$WEB_PORT
```

The literal string. That failure is silent — Next falls back to 3000 — so the shell form would
have worked on Linux CI while being broken on the machine this repo is developed on.

So the port is resolved in Node, through `@sentinel/config`, and Next is spawned as
`node <next-cli-entry>` (not the `next` bin shim, which is `next.CMD` on Windows). `dev`,
`start` and `start:e2e` all route through it. `test:e2e` is now wrapped in
`dotenv -e ../../.env` so `playwright.config.ts` can call `loadEnv(webEnvSchema)` and derive
both `baseURL` and `webServer.url` from the same `WEB_PORT`.

**Covering test:** the Playwright suite itself — its `baseURL` is now derived from `WEB_PORT`,
so if the launcher and the config ever disagree, all five tests fail to connect. Plus a direct
probe on a non-default port.

```
$ dotenv -e ../../.env -v NODE_ENV=production -v WEB_PORT=3123 -- node scripts/next-on-web-port.ts start
▲ Next.js 16.3.2
- Local:         http://localhost:3123
- Network:       http://192.168.2.123:3123
✓ Ready in 116ms

3123 -> 200
3000 -> 000        # no listener on the old default — correct
```

And the whole suite driven end-to-end on a third port, proving config and launcher agree:

```
$ pnpm exec dotenv -e ../../.env -v WEB_PORT=3222 -- playwright test
[WebServer] $ dotenv -e ../../.env -v NODE_ENV=production -v APP_ENV=test -- node scripts/next-on-web-port.ts start
  ok 4 [chromium] › smoke.spec.ts:77 › the CSP report collector accepts a violation report (101ms)
  ok 5 [chromium] › smoke.spec.ts:26 › the page does not scroll horizontally at a narrow viewport (423ms)
  ok 3 [chromium] › smoke.spec.ts:41 › a real response carries the security header table and a fresh CSP nonce (477ms)
  ok 1 [chromium] › smoke.spec.ts:18 › renders in both colour schemes (574ms)
  ok 2 [chromium] › smoke.spec.ts:3 › the marketing page renders with no console errors (887ms)
  5 passed (7.8s)
```

---

## I2 — the request body is bounded before it is read

**Changed.** `readBoundedBody` in `apps/web/src/csp-report.ts`, called by the route.
`CSP_REPORT_MAX_BYTES = 8 KB` — roughly twice the largest legitimate report, since the biggest
field the schema keeps is `original-policy` at 4 KB.

Two layers, and the comment says which is which. `Content-Length` is a fast path that rejects
without buffering a byte; it is client-supplied, so the actual control is a running byte total
that cancels the stream the moment the budget is exceeded regardless of what the header claimed.

**Covering test:** six cases in `src/csp-report.spec.ts`, including the header-lies case.

```
$ pnpm vitest run --project unit apps/web/src/csp-report.spec.ts
 ✓  unit  apps/web/src/csp-report.spec.ts (34 tests)
```

Live, against `next start`, reproducing the reviewer's own measurement (they saw 20 MB
accepted and buffered, 204 in 99 ms):

```
$ ls -l /tmp/huge.json
body size (bytes): 20971633
$ curl -X POST -H "content-type: application/csp-report" --data-binary @/tmp/huge.json .../api/csp-report
status=204 time=0.017587s
```

17 ms instead of 99 ms, and nothing was logged from it. A normal report still returns 204 and
still logs.

Incidental finding, reported and **not** acted on per the "do not fix anything outside this
list" instruction: Next itself warns at 10 MB in the proxy path —
`Request body exceeded 10MB for /api/csp-report … see middlewareClientMaxBodySize`. That is a
second, much higher ceiling that exists independently of this fix; my 8 KB cap fires far
earlier. Worth knowing that Next has an opinion here, in case another route ever wants a
larger body.

---

## I3 — `document-uri` and `referrer` no longer carry credentials into the log

**Changed.** `sanitizeReportedUrl` in `src/csp-report.ts`, applied by `parseCspReport` to both
fields. Query and fragment are dropped outright; each path segment is masked as `:seg` unless it
can be shown to be a route name (lowercase, ≤ 24 chars, not long-and-digit-bearing). The origin
is kept so a report stays attributable.

The false comment is gone. The replacement states the threat, the rule, **and what the rule does
not guarantee**:

> **What this does not guarantee.** It is a shape heuristic, not a route table. A token that
> happens to be short, lowercase and digit-free would survive it. The correct fix is to match
> the real route manifest and log the pattern, and that is owed by whichever phase ships
> token-bearing URLs — this is a floor, not a solution.

I also added a bullet to `transport-and-headers.md` §6 recording the control, because my new §3
text cross-references §6 and — after C1 — I was not going to ship another reference that did not
resolve.

**Covering test:** 20 cases. Masking a UUID, this repo's prefixed UUIDv7, a base64url token and
a long hex string; keeping the real route names from `page-map.md`; dropping query and fragment;
and a check that URL userinfo (`https://user:hunter2@…`) cannot survive.

Live, against the dev server, with a token in **both** the path and the query:

```
POST document-uri: http://localhost:3000/invitations/9f8b7c6d5e4f3a2b1c0d9e8f?token=live-secret
POST referrer:     http://localhost:3000/reset-password?token=another

[18:18:43.837] WARN: Content Security Policy violation
    service: "web"
    cspReport: {
      "document-uri": "http://localhost:3000/invitations/:seg",
      "referrer": "http://localhost:3000/reset-password",
      "violated-directive": "script-src",
      "blocked-uri": "inline"
    }
```

Neither token reached the log.

---

## I4 — a test that can actually fail

**Changed.** The route's logic moved to `apps/web/src/csp-report.ts` (parse, validate, strip,
sanitize, bound), leaving `route.ts` thin. New spec `apps/web/src/csp-report.spec.ts` — under
`apps/web/src/`, so it routes to the `unit` project.

The reviewer's complaint was precise: the route answers 204 to every input, so the E2E test
passed whether or not the handler existed. The new spec tests the module directly.

```
$ pnpm test
 ✓  unit  apps/web/src/csp-report.spec.ts (34 tests) 15ms
 ✓  unit  apps/web/src/security-headers.spec.ts (9 tests) 4ms
 Test Files  27 passed (27)
      Tests  321 passed (321)
```

**I mutation-tested it**, because "I wrote tests" is the same class of claim as the ones this
review caught. Two mutations, each reverting a control this round added:

```
### MUTATION 1: sanitizeReportedUrl returns the raw URL (the token leak) ###
   × parseCspReport > masks the document-uri before it can reach the log
   × parseCspReport > masks the referrer too, and leaves an empty referrer alone
   × sanitizeReportedUrl > drops the query string, where a reset or verification token rides
   × sanitizeReportedUrl > drops the fragment
   × sanitizeReportedUrl > masks a UUID in the path
   × sanitizeReportedUrl > masks this repo's prefixed UUIDv7 in the path
   × sanitizeReportedUrl > masks a base64url-ish token in the path
   × sanitizeReportedUrl > masks a long hex string in the path

### MUTATION 2: body cap removed (I2 regressed) ###
   × readBoundedBody > refuses a body larger than the cap
   × readBoundedBody > refuses on an oversized Content-Length without reading the stream
   × readBoundedBody > still refuses an oversized body when Content-Length lies about it
      Tests  3 failed | 31 passed (34)
```

Source restored and confirmed byte-identical (`diff` → no output). The spec also pins the
`.strip()` behaviour the docblock leans on: an injected unknown key is absent from the result
and its value appears nowhere in the serialised report.

---

## I5 — the cooldown bypasses are gone, not documented

**Changed.** All ten `minimumReleaseAgeExclude` entries removed from `pnpm-workspace.yaml`,
replaced by a comment recording the ruling.

The reviewer asked for an explicit ruling on whether bypassing the cooldown for a same-day
framework release is acceptable. I checked the actual numbers first:

```
$ npm view next time --json
16.3.2: 2026-08-21T09:54:02.099Z
16.3.1: 2026-08-13T22:45:02.025Z
```

`next@16.3.2` was published at 09:54Z and installed at ~13:00Z the same day — **roughly three
hours old**, squarely inside the window the control exists to cover. My earlier defence ("pnpm
wrote it") was not a defence, and the reviewer was right to say so.

Rather than justify them, I tested whether they are needed at all:

```
$ # exclusions deleted, then:
$ pnpm install
Lockfile is up to date, resolution step is skipped
Already up to date
$ pnpm install --frozen-lockfile      # what CI runs
Already up to date
$ pnpm install --lockfile-only
Already up to date
$ git diff --stat pnpm-lock.yaml
(no output — resolution unchanged)
```

Nothing needs them: the resolution is pinned, so the cooldown is not consulted again. Ten holes
removed instead of ten holes annotated. The comment left behind says what happened, why, and
what to do if pnpm ever offers to re-add them (wait out the cooldown or pin the previous
release — not accept the exemption).

**Covering test:** the three install commands above, plus the full lint/typecheck/test/build/
Playwright suite passing afterwards on the unchanged lockfile.

---

## I6 — missing React lint rules, recorded where a session will find it

**Changed.** `roadmap.md` "Known outstanding". Plugins **not** installed, per instruction.

The entry states that the gap is a missing guard rather than a present bug (the review read the
dependency arrays and found them correct), that it arrived at the moment the repo acquired the
code it guards, and why Task 13 did not install them.

**Covering test:** none applicable — this is a documentation placement fix. Verified by reading
the rendered list back.

---

## I7 — CI E2E stage recorded as a required Task 14 deliverable

**Changed.** `roadmap.md`. Rewritten from "Task 14's to add" into the same shape as the
vitest-project-guard carry-forward: **"Task 14 owes a CI end-to-end stage — a browser install
and `pnpm test:e2e`. Required, not suggested."** It names what the Playwright suite is the only
thing asserting (nonce reaches the HTML, enforcing CSP does not break the page, header table on
a real response) and that it passes on exactly one Windows machine and nowhere else.

**Covering test:** none applicable. CI itself is untouched, per the ruling that the edit belongs
to Task 14.

---

## M1 — `next-env.d.ts` untracked

**Changed.** `.gitignore` entry plus `git rm --cached`. The comment records the reviewer's own
finding that the clean-clone typecheck consequence does **not** hold, so this is cosmetic.

```
$ git ls-files --error-unmatch apps/web/next-env.d.ts
untracked (correct)
```

**Covering test:** `pnpm typecheck` green after the change (below); the file still exists on
disk and is still `.prettierignore`d.

---

## M4 — both CSP request-header names cleared

**Changed.** `apps/web/proxy.ts` now calls `requestHeaders.delete()` for both names before
setting one, so a client-supplied header under the *other* name cannot survive for Next to read
a nonce from. The comment notes report-only is development-only so there is nothing to bypass
today — "but 'today' is not a property worth depending on, and the fix is one line."

**Covering test:** the existing E2E nonce test, which asserts two successive responses carry
different nonces and that the policy contains no `unsafe-*`. Green below.

---

## M5 — the strongest assertion is now deterministic

**Changed.** `e2e/smoke.spec.ts` awaits `page.waitForLoadState('networkidle')` before reading
`errors`, so a CSP violation from a chunk that loads after first paint cannot land after the
assertion.

**Covering test:** the test itself. Its runtime moved from ~500 ms to ~840 ms across runs,
which is the wait actually happening rather than being optimised away:

```
  ok 5 [chromium] › smoke.spec.ts:3 › the marketing page renders with no console errors (836ms)
```

---

## M6 — the log sample now matches its provenance label

**Changed.** `transport-and-headers.md` §3 showed a JSON line labelled "against the running dev
server", but `src/logger.ts` sets `pretty: APP_ENV === 'development'`, so the dev server prints
the pretty form. Rather than relabel it, I re-ran the capture against an actual `next dev` and
pasted what it printed — the block above under I3 is that literal output. The label now names
why the form is pretty and cites the line of code that decides it.

**Covering test:** none possible (documentation). The capture is reproducible with the `curl`
in I3.

---

## M7 — the roadmap no longer claims an ungranted completion

**Changed.** "Tasks 1–13 are complete (13 pending its adversarial review)" →

> **Tasks 1–13 are complete.** Task 13 was implemented, independently reviewed (spec compliance
> pass, quality approved conditional on two corrections), and the fix round that corrected them
> has landed.

Written after the review landed and after C1/C2 were corrected, so it is true at the time of
writing.

---

## No action, per ruling

- **M2** `(auth)/layout.tsx` renders for no route — untouched.
- **M3** the appearance context is a seam nothing consumes — untouched.

---

## Full verification for this round

```
$ pnpm lint
 Tasks:    14 successful, 14 total
  Time:    3.18s

$ pnpm typecheck
@sentinel/web:typecheck: $ tsc -p tsconfig.json --noEmit
 Tasks:    14 successful, 14 total
  Time:    1.794s

$ pnpm test
 ✓  unit  apps/web/src/csp-report.spec.ts (34 tests) 15ms
 ✓  unit  apps/web/src/security-headers.spec.ts (9 tests) 4ms
 Test Files  27 passed (27)
      Tests  321 passed (321)

$ rm -rf apps/web/.next && pnpm build
@sentinel/web:build: ✓ Generating static pages using 7 workers (2/2) in 393ms
@sentinel/web:build: Route (app)
@sentinel/web:build: ┌ ƒ /
@sentinel/web:build: ├ ƒ /_not-found
@sentinel/web:build: ├ ƒ /api/csp-report
@sentinel/web:build: ├ ƒ /api/health
@sentinel/web:build: └ ƒ /dashboard
@sentinel/web:build: ƒ Proxy (Middleware)
 Tasks:    8 successful, 8 total
  Time:    7.362s

$ pnpm test:e2e
[WebServer] $ dotenv -e ../../.env -v NODE_ENV=production -v APP_ENV=test -- node scripts/next-on-web-port.ts start
Running 5 tests using 5 workers
  ok 1 [chromium] › smoke.spec.ts:77 › the CSP report collector accepts a violation report (88ms)
  ok 2 [chromium] › smoke.spec.ts:26 › the page does not scroll horizontally at a narrow viewport (411ms)
  ok 4 [chromium] › smoke.spec.ts:41 › a real response carries the security header table and a fresh CSP nonce (430ms)
  ok 3 [chromium] › smoke.spec.ts:18 › renders in both colour schemes (544ms)
  ok 5 [chromium] › smoke.spec.ts:3 › the marketing page renders with no console errors (836ms)
  5 passed (7.8s)

$ pnpm exec prettier --check "apps/web/**/*.{ts,tsx,css,mjs,json}" ".claude/**/*.md"
All matched files use Prettier code style!
```

Unit test count moved 287 → 321 (+34, all in `csp-report.spec.ts`). Playwright stays at 5.

## Still owed, unchanged by this round

The Step 6 visual confirmation. No human has looked at this page; nobody has judged the
typography, spacing, hierarchy or contrast, and no non-Chromium browser has loaded it.
