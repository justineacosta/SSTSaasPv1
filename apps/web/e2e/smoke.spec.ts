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

  // Exactly one of the two is sent, and which one is APP_ENV's decision.
  const policy =
    headers['content-security-policy'] ?? headers['content-security-policy-report-only'];
  expect(policy).toBeDefined();
  expect(policy).toContain("frame-ancestors 'none'");
  expect(policy).not.toContain('unsafe-inline');
  expect(policy).not.toContain('unsafe-eval');

  // A nonce reused across responses is the same as having no nonce at all.
  const second = await page.goto('/api/health');
  const secondPolicy =
    second?.headers()['content-security-policy'] ??
    second?.headers()['content-security-policy-report-only'];
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
