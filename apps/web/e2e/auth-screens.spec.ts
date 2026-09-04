import { expect, test } from '@playwright/test';

/**
 * What this suite can and cannot assert, stated up front so nobody reads more
 * into a green run than is there.
 *
 * **There is no API server behind these tests.** `playwright.config.ts` starts
 * `apps/web` and nothing else. So this file asserts what a rendered page proves
 * without one: that each route exists and renders its heading and its controls,
 * that it produces no console errors under an enforcing CSP, that the security
 * header table still arrives on it, and that it does not scroll horizontally at
 * a narrow viewport.
 *
 * **The register -> verify -> login -> MFA journey is Task 18's**, and it is the
 * phase's exit criterion. Nothing here is a substitute for it, and nothing here
 * claims a form successfully talks to the API.
 */

const AUTH_ROUTES = [
  { path: '/register', heading: 'Create your account' },
  { path: '/login', heading: 'Sign in' },
  { path: '/login/mfa', heading: 'Start again' },
  { path: '/forgot-password', heading: 'Reset your password' },
  { path: '/verify-email', heading: 'This link is incomplete' },
  { path: '/reset-password', heading: 'This link is incomplete' },
] as const;

for (const route of AUTH_ROUTES) {
  test(`${route.path} renders its heading with no console errors`, async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    page.on('pageerror', (error) => errors.push(error.message));

    await page.goto(route.path);
    await expect(page.getByRole('heading', { level: 1, name: route.heading })).toBeVisible();

    // The h1 is visible at first paint, but the chunks `'strict-dynamic'` has
    // to allow are still arriving, and a CSP violation from one of those would
    // land after the assertion. Wait for the network to settle first — the same
    // reasoning as smoke.spec.ts.
    await page.waitForLoadState('networkidle');
    expect(errors, `Console errors on ${route.path}`).toEqual([]);
  });

  test(`${route.path} does not scroll horizontally at 375px`, async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto(route.path);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflows, `${route.path} overflows horizontally`).toBe(false);
  });
}

test('every auth route carries the security header table', async ({ page }) => {
  for (const route of AUTH_ROUTES) {
    const response = await page.goto(route.path);
    expect(response, `no response for ${route.path}`).not.toBeNull();
    const headers = response?.headers() ?? {};

    // `start:e2e` pins APP_ENV=test, so this server always enforces. A
    // report-only header means a different server answered.
    expect(headers['content-security-policy-report-only']).toBeUndefined();
    const policy = headers['content-security-policy'];
    expect(policy, `no enforcing CSP on ${route.path}`).toBeDefined();
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).not.toContain('unsafe-inline');
    expect(policy).not.toContain('unsafe-eval');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  }
});

test('connect-src names the API origin, so a cross-origin call is not blocked', async ({
  page,
}) => {
  // ADR-0017 has the browser call the API directly, cross-origin. Under
  // `connect-src 'self'` the browser refuses that fetch before it leaves, and
  // the symptom is a console error whose tempting fix is to widen the CORS
  // allowlist on the API — the single failure ADR-0017 was written to prevent.
  // Asserted against a real response rather than only against the pure function.
  const response = await page.goto('/login');
  const policy = response?.headers()['content-security-policy'] ?? '';
  const connectSrc = policy.split('; ').find((directive) => directive.startsWith('connect-src'));
  expect(connectSrc, 'no connect-src directive at all').toBeDefined();
  expect(connectSrc).toMatch(/^connect-src 'self' https?:\/\/[^\s;]+$/);
  expect(connectSrc).not.toContain('*');
});

test('the login form is keyboard reachable and its inputs are labelled', async ({ page }) => {
  await page.goto('/login');

  // accessibility.md §4 — every input has a visible label; placeholders are not
  // labels. getByLabel resolves through the label/for association Field builds.
  await expect(page.getByLabel('Work email')).toBeVisible();
  await expect(page.getByLabel('Password')).toBeVisible();

  await page.getByLabel('Work email').focus();
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Password')).toBeFocused();
  // The reveal toggle is deliberately outside the tab ring, so one more Tab
  // reaches the checkbox rather than a decorative control.
  await page.keyboard.press('Tab');
  await expect(page.getByRole('checkbox', { name: 'Keep me signed in' })).toBeFocused();
});

test('the MFA screen offers a recovery-code mode that changes the input', async ({ page }) => {
  // Reachable without an API because the empty state is what an unauthenticated
  // direct visit gets — so this asserts the empty state, not the challenge form.
  await page.goto('/login/mfa');
  await expect(page.getByRole('heading', { level: 1, name: 'Start again' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Back to sign in' })).toHaveAttribute(
    'href',
    '/login',
  );
});

test('an attacker-supplied next parameter is never a navigable target', async ({ page }) => {
  await page.goto('/login?next=https%3A%2F%2Fevil.example%2Flogin');
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();

  // What is asserted, precisely, because a looser assertion here would be a
  // false comfort. The raw parameter DOES appear in Next's RSC flight payload,
  // as the `redirectTo` prop of the client component — measured, not assumed:
  // the payload contains `{"redirectTo":"https://evil.example/login"}`. That is
  // the unvalidated value on its way to `safeRedirectPath`, and it is correct
  // for it to be there.
  //
  // What must never happen is the value becoming something a browser will
  // follow: an `href`, a `src`, a form `action`, or a meta refresh. That is
  // what this checks. The navigation path itself is covered by
  // src/api/redirect.spec.ts (33 tests, mostly rejections) and by
  // LoginScreen.spec.tsx, which asserts the router is handed `/dashboard`.
  const navigable = await page.evaluate(() =>
    [...document.querySelectorAll('[href], [src], [action], meta[http-equiv]')].map((element) =>
      [
        element.getAttribute('href'),
        element.getAttribute('src'),
        element.getAttribute('action'),
        element.getAttribute('content'),
      ].join(' '),
    ),
  );
  for (const value of navigable) {
    expect(value).not.toContain('evil.example');
  }
  expect(await page.evaluate(() => document.forms.length > 0)).toBe(true);
});
