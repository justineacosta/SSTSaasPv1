import { expect, test } from '@playwright/test';

test('the marketing page renders with no console errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  // The h1 is visible at first paint, but the chunks that `'strict-dynamic'`
  // has to allow are still arriving — and a CSP violation from one of those
  // would land after the assertion, turning the strongest test in this suite
  // into one that passes by being early. Wait for the network to settle first.
  await page.waitForLoadState('networkidle');
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

/**
 * The unit spec asserts what `buildSecurityHeaders` returns. This asserts that
 * a real HTTP response from a real server actually carries it — the step
 * between a correct pure function and a correctly configured application,
 * which is exactly where a header table goes missing.
 */
test('a real response carries the security header table and a fresh CSP nonce', async ({
  page,
}) => {
  const first = await page.goto('/');
  expect(first).not.toBeNull();
  const headers = first?.headers() ?? {};

  // First, because it is the assertion that explains every other failure below
  // it. `start:e2e` pins APP_ENV=test, so the server this suite owns always
  // enforces; a report-only header means the response came from some *other*
  // server — the reason this used to read `enforcing ?? report-only` and
  // quietly accept either. Narrow guard: it catches a CSP-shaped mismatch
  // only. A stale server running old code with APP_ENV=test still slips
  // through, and nothing here detects that.
  expect(
    headers['content-security-policy-report-only'],
    'Response carries a report-only CSP. The E2E server pins APP_ENV=test and always enforces, so this is very likely a different server being reused — a `next dev` on E2E_PORT — rather than a defect in the header table.',
  ).toBeUndefined();
  expect(
    headers['content-security-policy'],
    'Response carries no enforcing CSP. Expected the APP_ENV=test server started by playwright.config.ts.',
  ).toBeDefined();

  expect(headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains; preload');
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['x-frame-options']).toBe('DENY');
  expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  expect(headers['permissions-policy']).toBe(
    'camera=(), microphone=(), geolocation=(), payment=()',
  );
  expect(headers['cross-origin-opener-policy']).toBe('same-origin');
  expect(headers['cross-origin-resource-policy']).toBe('same-origin');
  // Next's own header; the config sets poweredByHeader: false.
  expect(headers['x-powered-by']).toBeUndefined();

  const policy = headers['content-security-policy'];
  expect(policy).toContain("frame-ancestors 'none'");
  expect(policy).not.toContain('unsafe-inline');
  expect(policy).not.toContain('unsafe-eval');
  // Only meaningful in an enforcing policy, which is why it is only asserted
  // now that the header above has been pinned to the enforcing one — a
  // report-only policy is specified to ignore it, so security-headers.ts omits
  // it there. See security/transport-and-headers.md §3.
  expect(policy).toContain('upgrade-insecure-requests');

  // A nonce reused across responses is the same as having no nonce at all.
  const second = await page.goto('/api/health');
  const secondPolicy = second?.headers()['content-security-policy'];
  expect(secondPolicy).toBeDefined();
  expect(secondPolicy).not.toBe(policy);
});

test('the CSP report collector accepts a violation report', async ({ request }) => {
  const response = await request.post('/api/csp-report', {
    headers: { 'content-type': 'application/csp-report' },
    data: JSON.stringify({
      'csp-report': {
        'document-uri': 'http://localhost:3000/',
        'violated-directive': 'script-src',
        'blocked-uri': 'inline',
      },
    }),
  });
  expect(response.status()).toBe(204);
});
