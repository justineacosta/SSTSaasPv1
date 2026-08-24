### Task 13: `apps/web` — Next.js shell

**Files:**
- Create: `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/next.config.ts`, `apps/web/middleware.ts`, `apps/web/playwright.config.ts`
- Create: `apps/web/app/{layout.tsx,globals.css,fonts.ts,providers.tsx}`
- Create: `apps/web/app/(marketing)/page.tsx`, `apps/web/app/(auth)/layout.tsx`, `apps/web/app/(app)/layout.tsx`, `apps/web/app/(app)/page.tsx`
- Create: `apps/web/app/api/csp-report/route.ts`, `apps/web/app/api/health/route.ts`
- Create: `apps/web/e2e/smoke.spec.ts`
- Test: `apps/web/src/security-headers.spec.ts`

**Interfaces:**
- Consumes: `@sentinel/ui` (tokens and primitives), `@sentinel/config` (`webEnvSchema`)
- Produces: a Next.js app on `WEB_PORT` with the three route groups from `frontend.md` §1
- Produces: `buildSecurityHeaders(nonce: string, enforceCsp: boolean): Record<string, string>` — pure, shared by middleware and its test

- [ ] **Step 1: Write the failing header test**

Extract header construction into a pure function so it is testable without booting Next.

`apps/web/src/security-headers.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { buildSecurityHeaders } from './security-headers.js';

describe('buildSecurityHeaders', () => {
  it('emits a CSP carrying the supplied nonce', () => {
    const headers = buildSecurityHeaders('abc123', true);
    expect(headers['Content-Security-Policy']).toContain("'nonce-abc123'");
  });

  it('never allows unsafe-inline or unsafe-eval', () => {
    const csp = buildSecurityHeaders('abc123', true)['Content-Security-Policy'] ?? '';
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
  });

  it('sets frame-ancestors none and object-src none', () => {
    const csp = buildSecurityHeaders('abc123', true)['Content-Security-Policy'] ?? '';
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
  });

  it('restricts fonts to self, which is what next/font self-hosting buys', () => {
    const csp = buildSecurityHeaders('abc123', true)['Content-Security-Policy'] ?? '';
    expect(csp).toContain("font-src 'self'");
  });

  it('reports rather than enforces when enforcement is off', () => {
    const headers = buildSecurityHeaders('abc123', false);
    expect(headers['Content-Security-Policy']).toBeUndefined();
    expect(headers['Content-Security-Policy-Report-Only']).toBeDefined();
  });

  it('sets the full header table from transport-and-headers.md §2', () => {
    const headers = buildSecurityHeaders('abc123', true);
    expect(headers['Strict-Transport-Security']).toBe(
      'max-age=31536000; includeSubDomains; preload',
    );
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['X-Frame-Options']).toBe('DENY');
    expect(headers['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['Permissions-Policy']).toBe(
      'camera=(), microphone=(), geolocation=(), payment=()',
    );
    expect(headers['Cross-Origin-Opener-Policy']).toBe('same-origin');
    expect(headers['Cross-Origin-Resource-Policy']).toBe('same-origin');
  });
});
```

- [ ] **Step 2: Run it, verify it fails, then implement `security-headers.ts` and `middleware.ts`**

`middleware.ts` generates a nonce per request with `crypto.randomUUID()`, applies
`buildSecurityHeaders`, and forwards the nonce on a request header so `layout.tsx` can read it
for any `next/script` tag.

- [ ] **Step 3: Self-hosted fonts**

`apps/web/app/fonts.ts` uses `next/font/google` for IBM Plex Sans, IBM Plex Sans Condensed, and
IBM Plex Mono, each with an explicit `fallback` stack:

```ts
/**
 * next/font self-hosts these at build time, which is what keeps
 * `font-src 'self'` true rather than aspirational. A Google Fonts <link> would
 * silently require a CSP exception, and a CSP with exceptions nobody
 * remembers is how a strict policy erodes.
 */
```

Fallbacks per `design-system.md` §2: `ui-sans-serif, system-ui` for the sans faces,
`ui-monospace, SFMono-Regular, Menlo` for the mono.

- [ ] **Step 4: Route groups and placeholder pages**

Three groups per `frontend.md` §1, each with its own layout, and pages that say plainly what is
not built yet. `(marketing)/page.tsx` describes what Sentinel is. `(app)/page.tsx` says the
product is not built and names the current phase. **No mock product UI** — a convincing
screenshot of something that does not exist is the specific illusion this codebase avoids.

`app/api/csp-report/route.ts` accepts violation reports and logs them at `warn`. Wired from day
one, and the reports actually get read; a CSP nobody monitors is decoration
(`transport-and-headers.md` §3).

`app/providers.tsx` sets up TanStack Query plus theme and density context.

- [ ] **Step 5: Write the Playwright smoke spec**

`apps/web/e2e/smoke.spec.ts`:
```ts
import { expect, test } from '@playwright/test';

test('the marketing page renders with no console errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  expect(errors).toEqual([]);
});

test('renders in both colour schemes', async ({ page }) => {
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    await page.goto('/');
    await expect(page.locator('body')).toBeVisible();
  }
});

test('the page does not scroll horizontally at a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto('/');
  const overflows = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflows).toBe(false);
});
```

Add `"test:e2e": "playwright test"` to the root `package.json`. The full E2E suite waits for
Phase 2, when there are journeys to walk.

- [ ] **Step 6: Run it for real, not just in tests**

```bash
pnpm --filter @sentinel/web dev
# Open http://localhost:3000. Confirm by eye: the page renders, the type is
# IBM Plex, and toggling the OS colour scheme changes the theme.
pnpm --filter @sentinel/web build
pnpm test:e2e
```

- [ ] **Step 7: Verify and commit**

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
git add -A
git commit -m "$(cat <<'EOF'
feat(web): Next.js App Router shell with tokens, fonts, and CSP

Three route groups — (marketing), (auth), (app) — holding placeholder pages
that say plainly what is not built yet. No mock product UI: a convincing
screenshot of something that does not exist is the specific illusion this
codebase avoids.

IBM Plex Sans, Sans Condensed and Mono self-hosted through next/font, which
keeps font-src 'self' true rather than aspirational. Per-request CSP nonce in
middleware, the same header table the API sets, and a /api/csp-report route
wired from day one.

One Playwright smoke spec: renders in both colour schemes, no console errors,
no horizontal overflow at 375px. The full E2E suite waits for Phase 2, when
there are journeys to walk.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

