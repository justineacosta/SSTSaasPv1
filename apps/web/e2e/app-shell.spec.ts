import { expect, test, type Page } from '@playwright/test';

/**
 * What this suite can and cannot assert, stated up front so nobody reads more
 * into a green run than is there.
 *
 * **There is no API server behind these tests.** `playwright.config.ts` starts
 * `apps/web` and nothing else, so `GET /api/v1/auth/session` cannot succeed.
 * The `(app)` routes therefore show a **skeleton** and then, once the fetch
 * fails, the shell's error state — and never the navigation, the organisation
 * switcher, or anything else gated on a permission set that never arrives.
 * That is not a limitation to work around: it is exactly the property ADR-0025
 * and `architecture/frontend.md` §2 require, and it is the strongest
 * end-to-end statement available without a live API.
 *
 * **The authenticated journey against a live API is Task 18's.** Nothing here
 * claims a session was established, an organisation was switched, or a session
 * was revoked.
 *
 * The first version of this file asserted the skeleton *after* the network had
 * settled and failed on two of three routes: the session fetch is refused
 * quickly enough that the error state has already replaced it. Measured, not
 * assumed — `element(s) not found` for `app-shell-skeleton` on
 * `/settings/security` and `/settings/members`, and found on `/dashboard`,
 * which is a race rather than a difference between the routes.
 */

const APP_ROUTES = ['/dashboard', '/settings/security', '/settings/members'] as const;

/** The shell before a session exists: a skeleton, or the failure that replaced it. */
function preSessionShell(page: Page) {
  return page
    .getByTestId('app-shell-skeleton')
    .or(page.getByText('Your session could not be loaded.'));
}

/**
 * Nothing on this list may render before the permission set is known, and with
 * no API running it is never known.
 */
async function expectNoAffordances(page: Page): Promise<void> {
  await expect(page.getByRole('navigation', { name: 'Product' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Members' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
  await expect(page.getByLabel('Organisation')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send invitation' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Change password' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Begin enrolment' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Sign out all other devices' })).toHaveCount(0);
}

for (const path of APP_ROUTES) {
  test(`${path} renders the shell with no unexpected console errors`, async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    page.on('pageerror', (error) => errors.push(error.message));

    await page.goto(path);
    await expect(preSessionShell(page).first()).toBeVisible();

    // The chunks `'strict-dynamic'` has to allow are still arriving when the
    // shell first paints, and a CSP violation from one of those would land
    // after the assertion. Same reasoning as `auth-screens.spec.ts`.
    await page.waitForLoadState('networkidle');

    // The session fetch cannot succeed here — no API is running — so the
    // network failure it produces is expected and is not a defect. Everything
    // else must be silent, and a CSP violation would appear here.
    const unexpected = errors.filter(
      (message) =>
        !/Failed to load resource|net::ERR_|fetch|Fetch|NetworkError|Load failed/i.test(message),
    );
    expect(unexpected, `Unexpected console errors on ${path}`).toEqual([]);
  });

  test(`${path} withholds every affordance until the session resolves`, async ({ page }) => {
    // THE ADR-0025 ASSERTION, end to end. `frontend.md` §2 bans a flash of
    // forbidden UI; the shell honours it by rendering nothing gated at all
    // until the permission set arrives, and with no API it never arrives.
    await page.goto(path);
    await expect(preSessionShell(page).first()).toBeVisible();
    await expectNoAffordances(page);

    await page.waitForLoadState('networkidle');
    await expectNoAffordances(page);
  });

  test(`${path} does not scroll horizontally at 375px`, async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto(path);
    await expect(preSessionShell(page).first()).toBeVisible();
    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflows, `${path} overflows horizontally`).toBe(false);
  });
}

test('every (app) route carries the security header table', async ({ page }) => {
  for (const path of APP_ROUTES) {
    const response = await page.goto(path);
    expect(response, `no response for ${path}`).not.toBeNull();
    const headers = response?.headers() ?? {};

    // `start:e2e` pins APP_ENV=test, so this server always enforces. A
    // report-only header means a different server answered.
    expect(headers['content-security-policy-report-only']).toBeUndefined();
    const policy = headers['content-security-policy'];
    expect(policy, `no enforcing CSP on ${path}`).toBeDefined();
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).not.toContain('unsafe-inline');
    expect(policy).not.toContain('unsafe-eval');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  }
});

test('the (app) group is answered dynamically and is never cached', async ({ page }) => {
  // `architecture/frontend.md` §2: "Never cached: any response containing
  // tenant data." The `(app)` layout's docblock says Next produces this header
  // on its own for a dynamic route rather than the layout setting it, so this
  // asserts the claim rather than trusting the comment.
  for (const path of APP_ROUTES) {
    const response = await page.goto(path);
    const cacheControl = response?.headers()['cache-control'] ?? '';
    expect(cacheControl, `${path} is cacheable`).toContain('no-store');
  }
});

test('the dashboard still refuses to invent a product', async ({ page }) => {
  // The Phase 1 "no mock product UI" rule. Task 17 changed the copy only as far
  // as became true, and this asserts the half that did not: there is still no
  // asset, scan or finding, so there is nothing for an overview to show. It is
  // asserted on the raw HTML because the page body sits behind the shell with
  // no API running.
  const response = await page.goto('/dashboard');
  const html = (await response?.text()) ?? '';
  expect(html).toContain('There is no product here yet');
  expect(html).toContain('no scan and no finding');
});
