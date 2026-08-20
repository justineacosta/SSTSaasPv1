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

export interface RateLimitClassConfig {
  readonly perIp?: Window;
  readonly perPrincipal?: Window;
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

export const RATE_LIMIT_CLASSES = {
  login: {
    perPrincipal: { limit: 5, windowSeconds: 900 },
    perIp: { limit: 20, windowSeconds: 900 },
    failMode: 'closed',
  },
  registration: { perIp: { limit: 3, windowSeconds: 3600 }, failMode: 'closed' },
  passwordReset: {
    perPrincipal: { limit: 3, windowSeconds: 3600 },
    perIp: { limit: 10, windowSeconds: 3600 },
    failMode: 'closed',
  },
  emailVerificationResend: {
    perPrincipal: { limit: 3, windowSeconds: 3600 },
    failMode: 'closed',
  },
  invitations: { perOrganization: { limit: 50, windowSeconds: 86_400 }, failMode: 'closed' },
  // §1 reads "Per plan (maxScansPerMonth), plus 10 / min burst". The monthly
  // figure is a quota, not a rate limit — quotas come from entitlements and are
  // checked before enqueue and again in the worker (§2). This is the burst.
  scanCreate: { perOrganization: { limit: 10, windowSeconds: 60 }, failMode: 'closed' },
  evidenceUpload: { perOrganization: { limit: 100, windowSeconds: 3600 }, failMode: 'closed' },
  reportGeneration: { perOrganization: { limit: 10, windowSeconds: 3600 }, failMode: 'closed' },
  generalSession: { perPrincipal: { limit: 1000, windowSeconds: 60 }, failMode: 'open' },
  generalApiKey: { perPrincipal: { limit: 600, windowSeconds: 60 }, failMode: 'open' },
} as const satisfies Record<string, RateLimitClassConfig>;

export type RateLimitClass = keyof typeof RATE_LIMIT_CLASSES;

/** The scopes a class may be keyed by, in the order the guard evaluates them. */
export const RATE_LIMIT_SCOPES = ['perIp', 'perPrincipal', 'perOrganization'] as const;

export type RateLimitScope = (typeof RATE_LIMIT_SCOPES)[number];
