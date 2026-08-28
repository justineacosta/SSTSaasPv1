/**
 * The rate-limit table from security/abuse-prevention.md §1, as configuration.
 *
 * Limits are configuration rather than constants because §1 says they are
 * overridable per plan. Phase 1 ships the defaults; the per-plan override
 * arrives with entitlements in Phase 10, and it reads this shape.
 *
 * One row of §1 is deliberately absent: **webhook test delivery, 10/hour per
 * endpoint**. Its scope is a webhook endpoint ID, which is neither an IP, a
 * principal, nor an organisation, and there is nothing in this codebase that
 * can resolve one until the webhooks module ships in Phase 9. Transcribing it
 * against the wrong scope would be worse than leaving it out, because it would
 * look enforced. It arrives with the module that can key it.
 */

export interface Window {
  readonly limit: number;
  readonly windowSeconds: number;
}

/**
 * Where the `perPrincipal` scope's identifier comes from.
 *
 * The three per-*account* rows of §1 — login, password reset, email
 * verification resend — are unauthenticated by definition: a failed login
 * carries no authenticated principal, and "5 / 15 min per account" means the
 * account being *attempted*, which lives in the request body. Reading
 * `request.principalId` for those classes resolves nothing, and because their
 * `perIp` scope does resolve, the miss would be skipped silently — a route that
 * looks limited, advertises a limit in its headers, and does not apply the
 * control that actually stops credential stuffing.
 *
 * `'authenticated'` is the session/API-key principal. `{ bodyField }` names the
 * field to read instead; its value is hashed before it becomes part of a key,
 * so an email address never lands in Redis or in a `KEYS` listing in plaintext.
 */
export type PrincipalSource = 'authenticated' | { readonly bodyField: string };

interface BaseRateLimitClassConfig {
  readonly perIp?: Window;
  readonly perOrganization?: Window;
  /**
   * What to do when the limiter cannot reach a decision — Redis is unavailable,
   * or no declared scope could be resolved.
   *
   * 'closed' on authentication endpoints: a Redis outage must not become a
   * window for credential stuffing. 'open' on read-only endpoints: an outage
   * should not lock every customer out of reading their own data.
   * See abuse-prevention.md §1.
   */
  readonly failMode: 'open' | 'closed';
}

/**
 * `principalSource` is **mandatory** whenever `perPrincipal` is declared, and
 * that is enforced by the type rather than by a comment.
 *
 * A comment saying "required" is what allowed the original defect: a class
 * declaring `perPrincipal` with no source silently defaulted to the
 * authenticated principal, which resolves to nothing on an unauthenticated
 * endpoint — and because such classes also declare `perIp`, the miss was
 * skipped without a signal. MFA verification, magic links and phone OTP are all
 * Phase 2 classes of exactly that shape, so this has to be a compile error
 * before they are written, not a review finding afterwards.
 */
export type RateLimitClassConfig = BaseRateLimitClassConfig &
  (
    | { readonly perPrincipal: Window; readonly principalSource: PrincipalSource }
    | { readonly perPrincipal?: undefined; readonly principalSource?: undefined }
  );

export const RATE_LIMIT_CLASSES = {
  login: {
    perPrincipal: { limit: 5, windowSeconds: 900 },
    perIp: { limit: 20, windowSeconds: 900 },
    principalSource: { bodyField: 'email' },
    failMode: 'closed',
  },
  registration: { perIp: { limit: 3, windowSeconds: 3600 }, failMode: 'closed' },
  passwordReset: {
    perPrincipal: { limit: 3, windowSeconds: 3600 },
    perIp: { limit: 10, windowSeconds: 3600 },
    // §1 reads "3 / hour per address". The address is the one being reset, not
    // a logged-in user — nobody is logged in on this endpoint.
    principalSource: { bodyField: 'email' },
    failMode: 'closed',
  },
  /**
   * Submitting a verification token — `POST /api/v1/auth/verify-email`.
   *
   * ADDED IN TASK 8, AND NOT A ROW TRANSCRIBED FROM §1's TABLE. §1 has a row
   * for the resend and none for the submission, so the figure below is a
   * decision made here and written into that table in the same change.
   *
   * **Defaulting it was not available.** A route carrying no class falls to
   * `generalSession`, which is `failMode: 'open'` with `perPrincipal:
   * 'authenticated'` as its only scope — unresolvable on an unauthenticated
   * route — and carry-forward ruling 55 records that nothing warns when that
   * happens at the default log level. The default is therefore not a weak limit
   * on this route; it is no limit and no signal. Applying
   * `emailVerificationResend` instead would be worse: its `principalSource` is
   * the body field `email`, which `verifyEmailRequestSchema` does not contain,
   * so the per-account half would resolve nothing on every single request while
   * the per-IP half resolved — the exact silent miss this file's
   * `PrincipalSource` docblock was written about.
   *
   * **Per IP only, because there is no account to key on.** The request body is
   * `{ token }` and nothing else. Deriving a principal from the token would
   * mean looking it up before the limiter could decide, which is a database
   * read bought by an unauthenticated caller — the thing the limiter runs first
   * to prevent.
   *
   * **30/hour is not about guessing the token.** `secret-token.ts` fixes the
   * secret at 32 random bytes, so brute force is infeasible at any rate this
   * table could express. What this bounds is an unmetered write attempt against
   * Postgres from an unauthenticated endpoint: every submission runs a
   * conditional `UPDATE` inside a transaction. A real user submits once, twice
   * if they mistype a copy-paste; 30 leaves a family behind one NAT or one
   * office egress address room to verify a batch of accounts in an hour, which
   * is the failure the tighter figures in this table risk.
   *
   * Fail closed, with the rest of the authentication classes: a Redis outage
   * must not become an unbounded write channel.
   */
  emailVerificationConsume: { perIp: { limit: 30, windowSeconds: 3600 }, failMode: 'closed' },
  emailVerificationResend: {
    perPrincipal: { limit: 3, windowSeconds: 3600 },
    // §1's table names only the per-account figure, but §1's opening sentence
    // says limits are applied per IP **and** per principal, and this class needs
    // the IP half more than most: it is unauthenticated, it names a third-party
    // address, and it makes us send mail. Without a per-IP bound one client can
    // name unlimited fresh addresses — an outbound-email amplifier aimed at
    // people who are not our customers, which is the case this document opens
    // by saying we limit abuse to prevent. The figure matches password reset,
    // the closest analogue in the table.
    perIp: { limit: 10, windowSeconds: 3600 },
    principalSource: { bodyField: 'email' },
    failMode: 'closed',
  },
  invitations: { perOrganization: { limit: 50, windowSeconds: 86_400 }, failMode: 'closed' },
  // §1 reads "Per plan (maxScansPerMonth), plus 10 / min burst". The monthly
  // figure is a quota, not a rate limit — quotas come from entitlements and are
  // checked before enqueue and again in the worker (§2). This is the burst.
  scanCreate: { perOrganization: { limit: 10, windowSeconds: 60 }, failMode: 'closed' },
  evidenceUpload: { perOrganization: { limit: 100, windowSeconds: 3600 }, failMode: 'closed' },
  reportGeneration: { perOrganization: { limit: 10, windowSeconds: 3600 }, failMode: 'closed' },
  generalSession: {
    perPrincipal: { limit: 1000, windowSeconds: 60 },
    principalSource: 'authenticated',
    failMode: 'open',
  },
  generalApiKey: {
    perPrincipal: { limit: 600, windowSeconds: 60 },
    principalSource: 'authenticated',
    failMode: 'open',
  },
} as const satisfies Record<string, RateLimitClassConfig>;

export type RateLimitClass = keyof typeof RATE_LIMIT_CLASSES;

/** The scopes a class may be keyed by, in the order the guard evaluates them. */
export const RATE_LIMIT_SCOPES = ['perIp', 'perPrincipal', 'perOrganization'] as const;

export type RateLimitScope = (typeof RATE_LIMIT_SCOPES)[number];
