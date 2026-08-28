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
