import { expect, test } from '@playwright/test';
import { staleTotpCode, totpCodeAt, totpStepAt, waitForStepAfter } from './support/authenticator';
import { JOURNEY_PASSWORD, registerAndVerify, signIn, uniqueEmail } from './support/journey';
import { resetRateLimits } from './global-setup';
import { linkFromEmail, waitForEmail } from './support/mailpit';

/**
 * The failure paths, because `user-flows.md` §8 calls them "failure paths that
 * must be designed, not discovered" and a designed state that nothing exercises
 * is a design document, not a behaviour.
 *
 * The plan's Task 18 names five: wrong password, expired reset link, reused
 * reset link, MFA lockout after five attempts, and session expiry restoring the
 * intended destination. Four are here. **The expired reset link is not, and
 * that is recorded rather than quietly dropped**: `TOKEN_TTL_PASSWORD_RESET_
 * SECONDS` is 3600 and is read at API boot, so an expiring-link test would
 * either sleep for an hour or need the harness to boot a third API with a
 * one-second TTL. The reused link below exercises the same single-use branch
 * and the same rendered state; expiry is covered at the integration layer,
 * where the clock can be moved.
 *
 * These run against the same shared Mailpit and Postgres as the journey, so
 * every account is uniquely addressed for the reason `support/journey.ts` gives.
 */

test.describe.serial('failure paths', () => {
  /**
   * Serial, and the rate limiter is reset before each test.
   *
   * This file registers FOUR accounts and `registration` allows **3 per IP per
   * hour**. Measured: the fourth test failed at its registration step with the
   * refusal on screen, not with anything to do with what it was testing.
   * Clearing per test is what makes each one hermetic — and it has to be serial
   * for that to be sound, because a parallel worker clearing the counters
   * mid-test would erase a limit another test was deliberately driving.
   *
   * It also sharpens the lockout test below. With the login limiter freshly
   * cleared, a refusal after five bad codes is the **account lockout** rather
   * than `login.perPrincipal`'s 5-per-15-minutes, which would otherwise be an
   * equally good explanation for the same red screen.
   */
  test.beforeEach(async () => {
    await resetRateLimits();
  });

  test('a wrong password is refused without saying whether the account exists', async ({
    page,
  }) => {
    const email = uniqueEmail('wrongpw');
    await registerAndVerify(page, email, async () => {
      const body = await waitForEmail(email, 'Confirm your email address');
      return linkFromEmail(body, '/verify-email');
    });

    await signIn(page, email, 'this-is-not-the-password');

    // Still on /login, with a visible refusal and no session.
    await expect(page).toHaveURL(/\/login/u);
    await expect(page.getByRole('alert').first()).toBeVisible();

    // The refusal must not become an account-existence oracle. This asserts the
    // *rendered* copy names neither branch — the byte-level equality of the two
    // responses is asserted at the API layer, where it can be compared exactly.
    const rendered = (await page.locator('body').innerText()).toLowerCase();
    expect(rendered).not.toContain('no account');
    expect(rendered).not.toContain('does not exist');
    expect(rendered).not.toContain('wrong password');
    expect(rendered).not.toContain('incorrect password');
  });

  test('a reset link works once and is refused the second time', async ({ page }) => {
    const email = uniqueEmail('reset');
    await registerAndVerify(page, email, async () => {
      const body = await waitForEmail(email, 'Confirm your email address');
      return linkFromEmail(body, '/verify-email');
    });

    await page.goto('/forgot-password');
    await page.getByLabel('Work email').fill(email);
    await page.getByRole('button', { name: 'Send reset link' }).click();

    const body = await waitForEmail(email, 'Reset your Sentinel password');
    const resetPath = linkFromEmail(body, '/reset-password');
    const newPassword = 'a-completely-different-password-9';

    await page.goto(resetPath);
    await page.getByLabel('New password', { exact: true }).fill(newPassword);
    await page.getByRole('button', { name: 'Set new password' }).click();
    await expect(page.getByText('Password changed')).toBeVisible();

    // The same link again. Single-use is the property; the screen must show a
    // designed state rather than a raw error or a dead end.
    await page.goto(resetPath);
    await page.getByLabel('New password', { exact: true }).fill(newPassword);
    await page.getByRole('button', { name: 'Set new password' }).click();
    await expect(page.getByRole('alert').first()).toBeVisible();

    // And the new password is genuinely the one that works.
    await signIn(page, email, newPassword);
    await expect(page).toHaveURL(/\/dashboard$/u);
  });

  test('five wrong authenticator codes lock the challenge out', async ({ page }) => {
    const email = uniqueEmail('lockout');
    await registerAndVerify(page, email, async () => {
      const body = await waitForEmail(email, 'Confirm your email address');
      return linkFromEmail(body, '/verify-email');
    });

    await signIn(page, email, JOURNEY_PASSWORD);
    await expect(page).toHaveURL(/\/dashboard$/u);

    // Enrol, so there is a second factor to fail against.
    await page.goto('/settings/security');
    const setup = page.getByRole('form', { name: 'Set up an authenticator' });
    await setup.getByLabel('Current password').fill(JOURNEY_PASSWORD);
    await setup.getByRole('button', { name: 'Begin enrolment' }).click();

    const secret = (await page.getByTestId('mfa-secret').innerText()).trim();
    const confirm = page.getByRole('form', { name: 'Confirm enrolment' });
    await confirm.getByLabel('Code from your authenticator').fill(totpCodeAt(secret));
    await confirm.getByRole('button', { name: 'Confirm' }).click();
    await expect(page.getByTestId('recovery-codes')).toBeVisible();
    const acceptedStep = totpStepAt();

    await page.getByRole('button', { name: 'Sign out' }).first().click();
    await expect(page).toHaveURL(/\/login/u);

    await signIn(page, email, JOURNEY_PASSWORD);
    await expect(page).toHaveURL(/\/login\/mfa$/u);

    // Five wrong codes. Stale rather than random, so each is wrong with
    // certainty rather than with probability 1 − 10⁻⁶.
    for (let attempt = 0; attempt < 5; attempt++) {
      await page.getByLabel('Authentication code').fill(staleTotpCode(secret));
      await page.getByRole('button', { name: 'Verify code' }).click();
      await expect(page.getByRole('alert').first()).toBeVisible();
    }

    // The sixth attempt uses a code that WOULD be valid. If the lockout is real
    // it is refused anyway, which is the whole assertion — a lockout that lets
    // a correct code through is not a lockout. Waiting past the accepted step
    // first, so a refusal cannot be blamed on the replay defence.
    await waitForStepAfter(acceptedStep);
    await page.getByLabel('Authentication code').fill(totpCodeAt(secret));
    await page.getByRole('button', { name: 'Verify code' }).click();

    await expect(page).not.toHaveURL(/\/dashboard$/u);
    await expect(page.getByRole('alert').first()).toBeVisible();
  });

  test('an expired session returns to login and restores the destination', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      const email = uniqueEmail('expiry');
      await registerAndVerify(page, email, async () => {
        const body = await waitForEmail(email, 'Confirm your email address');
        return linkFromEmail(body, '/verify-email');
      });

      await signIn(page, email, JOURNEY_PASSWORD);
      await expect(page).toHaveURL(/\/dashboard$/u);

      await page.goto('/settings/security');
      await expect(page).toHaveURL(/\/settings\/security$/u);

      // Expiry is simulated by destroying the session cookie rather than by
      // waiting out SESSION_IDLE_TIMEOUT_SECONDS (86400). What is under test is
      // the *screen's* response to a 401 — `isSessionExpiry` and
      // `loginHrefForDestination`, which Task 16 built and left with no caller
      // until Task 17 — and the screen cannot tell the two apart: both arrive as
      // the same 401 from the same guard.
      await context.clearCookies();

      // The next request from the authenticated shell.
      await page.reload();

      // §8's row: "Return to login and restore the intended destination after
      // re-auth." The destination must survive in `next`.
      await expect(page).toHaveURL(/\/login\?next=%2Fsettings%2Fsecurity$/u);

      await page.getByLabel('Work email').fill(email);
      await page.getByLabel('Password', { exact: true }).fill(JOURNEY_PASSWORD);
      await page.getByRole('button', { name: 'Sign in' }).click();

      // Back where they were trying to go, not on the dashboard.
      await expect(page).toHaveURL(/\/settings\/security$/u);
    } finally {
      await context.close();
    }
  });
});
