import { expect, type Page } from '@playwright/test';
import { E2E_API_ORIGIN } from '../../playwright.config';
import { resetRateLimits } from '../global-setup';

/**
 * Fixtures and the one API call the journey cannot make through the product.
 */

/**
 * A password that satisfies `passwordSchema` (12–256 characters) and is not
 * going to appear in a breach corpus. The breach check is off by default
 * (`PASSWORD_BREACH_CHECK_ENABLED=false`, ADR-0015) so this is belt and braces.
 */
export const JOURNEY_PASSWORD = 'correct-horse-battery-staple-42';

/**
 * A unique address per run, because **this suite never resets the database.**
 *
 * `prisma migrate reset` cannot be run by an agent at all (Task 1's ruling 3),
 * and a suite that wiped the developer's local database in order to test itself
 * would be a worse tool than one that leaves a few rows behind. Uniqueness is
 * what makes that safe: no run can collide with a previous run's account, an
 * `@unique` email, or a leftover invitation.
 *
 * `@sentinel.local` matches the domain the rest of local development uses, so
 * these are visibly test rows in Mailpit rather than something that looks like
 * a real customer.
 */
export function uniqueEmail(label: string): string {
  const unique = `${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}`;
  return `e2e-${label}-${unique}@sentinel.local`;
}

/** A slug that satisfies `organizationSlugSchema`: lowercase kebab, 3–63 chars. */
export function uniqueSlug(label: string): string {
  const unique = `${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}`;
  return `e2e-${label}-${unique}`.toLowerCase();
}

/**
 * Creates an organisation by calling the API from inside the page.
 *
 * # THIS IS THE ONE STEP OF THE JOURNEY THAT IS NOT DRIVEN THROUGH THE UI, AND
 * # IT IS NOT DRIVEN THROUGH THE UI BECAUSE THERE IS NO UI
 *
 * `createOrganization` does not exist anywhere in `apps/web` — Task 13 built
 * `POST /api/v1/organizations` and no task has ever built a screen for it. The
 * consequence is a product hole rather than a testing inconvenience: a newly
 * registered user belongs to no organisation, and the organisation switcher's
 * own empty state tells them "An invitation from an existing member is how you
 * join one" — which cannot happen, because there is no member to invite them
 * until somebody has an organisation. Recorded in `roadmap.md` under Task 18;
 * the operator's decision on 2026-09-08 was to call the API here and name the
 * gap rather than widen this task into building a second screen.
 *
 * **`page.evaluate` rather than Playwright's `request` fixture**, and the
 * difference matters. This has to be a real browser request from the real
 * origin: `CsrfGuard` compares the `X-CSRF-Token` header to a value derived
 * from the session cookie, and `CrossSiteGuard` checks `Origin` against
 * `WEB_BASE_URL`. A request built outside the page carries neither header
 * unless the test forges them, and a test that forges its way past two security
 * guards is testing its own forgery. Running `fetch` in the page means the
 * browser attaches the cookies, the origin and the fetch metadata exactly as it
 * would for the screen that ought to exist.
 */
export async function createOrganizationThroughApi(
  page: Page,
  name: string,
  slug: string,
): Promise<string> {
  const result = await page.evaluate(
    async ({ apiOrigin, body }) => {
      // The CSRF cookie is deliberately readable by script — that is what
      // double-submit requires — and `apps/web/src/api/client.ts` reads it the
      // same way for every unsafe request the product makes.
      const csrf = document.cookie
        .split('; ')
        .find((pair) => pair.startsWith('__Host-csrf='))
        ?.slice('__Host-csrf='.length);

      const response = await fetch(`${apiOrigin}/api/v1/organizations`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          ...(csrf === undefined ? {} : { 'X-CSRF-Token': csrf }),
        },
        body: JSON.stringify(body),
      });

      return { status: response.status, text: await response.text() };
    },
    { apiOrigin: E2E_API_ORIGIN, body: { name, slug } },
  );

  expect(result.status, `Creating the organisation ${slug} failed: ${result.text}`).toBe(201);

  const created = JSON.parse(result.text) as { id: string };
  return created.id;
}

/**
 * Registers, then follows the verification link out of Mailpit.
 *
 * Deliberately *not* a fixture that seeds the database directly. The point of
 * the journey is that these steps work through the product, and a helper that
 * inserted a verified user would delete the only coverage the phase's exit
 * criterion actually asks for.
 */
export async function registerAndVerify(
  page: Page,
  email: string,
  waitForVerificationLink: () => Promise<string>,
): Promise<void> {
  // Immediately before the registration, not once per run and not once per
  // test. `registration` allows 3 per IP per hour and this suite registers six
  // accounts across two files; a reset anywhere further away leaves a window in
  // which some other spec has spent the budget. Race-free only because
  // `playwright.config.ts` pins `workers: 1` — see the comment there, and CI run
  // 34191547593, which is what proved a per-test reset was not enough.
  await resetRateLimits();

  await page.goto('/register');
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(JOURNEY_PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();

  await expect(page.getByText('Check your email')).toBeVisible();

  await page.goto(await waitForVerificationLink());
  await expect(page.getByText('Email verified')).toBeVisible();
}

/** Signs in with a password. Stops at whatever the API asks for next. */
export async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}
