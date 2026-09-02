import { assertUserPrincipal } from '@sentinel/contracts';
import type { Request } from 'express';

/**
 * The three request-derived fields `security/audit.md` §3 puts on every event,
 * lifted off the Express request once at the controller.
 *
 * A service takes this rather than a `Request`, for the reason
 * `emails/links.ts` gives one layer over: a component that can see a request
 * can build a link from a forged `Host` header, and a component that cannot see
 * one has no way to. Nothing below the controller in this module ever holds a
 * request object.
 *
 * All three are `string | null` rather than optional. `null` is a caller saying
 * "not recorded"; an absent property is a caller who forgot, and an audit row
 * must be able to tell those apart.
 */
export interface AuthRequestContext {
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly requestId: string | null;
}

/**
 * `request.ip` is Express's socket peer address, because `trust proxy` is
 * disabled — `security/abuse-prevention.md` §1 records why, and the same
 * address is what the rate limiter keys on. An `X-Forwarded-For` value is not
 * read here and must not be: it is client-chosen, and an audit row carrying a
 * client-chosen address is worse than one carrying none.
 *
 * The user agent is a header the client picks outright, so it is bounded before
 * it is stored. 512 characters is longer than any real agent string and short
 * enough that an unauthenticated caller cannot write a megabyte into an
 * append-only table one request at a time.
 */
const USER_AGENT_MAX_LENGTH = 512;

export function requestContextOf(request: Request): AuthRequestContext {
  const userAgent = request.headers['user-agent'];
  return {
    ip: request.ip ?? null,
    userAgent: typeof userAgent === 'string' ? userAgent.slice(0, USER_AGENT_MAX_LENGTH) : null,
    requestId: request.id ?? null,
  };
}

/**
 * The authenticated caller, or a loud failure.
 *
 * `AuthenticationGuard` sets `request.principal` on every non-public route, so
 * `undefined` here is unreachable in a booted application — the boot-time
 * access assertion refuses to start on a route that declares nothing. It
 * **throws** rather than coalescing to an anonymous default, for the reason
 * `assertUserPrincipal`'s own docblock gives: a privileged path reachable by
 * omission is only safe if reaching it is loud. A `?? { userId: '', sessionId:
 * '' }` here would revoke session `''` and answer a session document for user
 * `''`.
 *
 * `assertUserPrincipal` is what refuses the `apiKey` arm, which Phase 2 cannot
 * construct.
 *
 * **It lives here rather than in `auth.controller.ts`, where it was written.**
 * Task 13 gives it a second caller — `OrganizationsController`, whose every
 * route needs the caller's own user id and must not read one from the request
 * (ADR-0020, carry-forward ruling 9) — and a second private copy of a function
 * that decides who the caller is is the shape two answers to that question
 * start from.
 */
export function principalOf(request: Request): { userId: string; sessionId: string } {
  const principal = request.principal;
  if (principal === undefined) {
    throw new Error(
      'Reached an authenticated handler with no principal on the request. AuthenticationGuard did not run.',
    );
  }
  return assertUserPrincipal(principal);
}
