import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ERROR_CODES, type UserPrincipal } from '@sentinel/contracts';
import type { Request } from 'express';
import { SESSION_COOKIE_NAME } from '../../modules/auth/cookies.js';
import { SessionService, type SessionResolution } from '../../modules/auth/session.service.js';
import {
  ACCESS_METADATA_KEY,
  ALLOW_PENDING_MFA_KEY,
  type AccessDeclaration,
} from '../decorators/access.decorator.js';
import { DomainError } from '../errors/domain-error.js';
import { readCookie } from '../http/cookie-header.js';

declare module 'express' {
  interface Request {
    /**
     * Set by `AuthenticationGuard` on every request that reached a non-public
     * route with a usable credential. `undefined` on a public route, always.
     *
     * **`principalId` and `organizationId` are deliberately NOT set here** —
     * Task 7's rulings B and F. Both are `RateLimitGuard`'s fields, and under
     * `architecture/backend.md` §3 the limiter runs *before* this guard, so a
     * value written here has already missed its only reader. Writing it anyway
     * would make `generalSession`'s per-principal limit look wired while
     * resolving nothing on every request. `organizationId` is Task 12's, which
     * owns tenant resolution.
     */
    principal?: UserPrincipal;
  }
}

/**
 * The narrow slice of `SessionService` this guard uses.
 *
 * The same narrow-port shape `TokenService`'s `VerificationTokenStore` uses,
 * for the same reason: a guard typed against the whole service is a guard whose
 * every spec is either a mock of the world or an integration test. `resolve` is
 * all of it — this guard issues nothing, rotates nothing and revokes nothing.
 */
export interface SessionResolver {
  resolve(token: string): Promise<SessionResolution>;
}

/** The shape `resolve` hands back for a live session. */
interface ResolvedIdentity {
  readonly id: string;
  readonly userId: string;
  readonly status: 'PENDING_MFA' | 'ACTIVE';
}

/**
 * No credential at all: no cookie, an empty one, or two cookies of that name.
 *
 * `api/authentication.md` §6 keeps this distinct from `SESSION_EXPIRED`, and the
 * frontend uses the difference to choose between "log in" and "your session
 * ended". One code for both would show a first-time visitor and a user whose
 * session lapsed the same message, and one of them would be wrong.
 */
function unauthenticated(): DomainError {
  return new DomainError(ERROR_CODES.UNAUTHENTICATED, 'Authentication is required.', 401);
}

/**
 * The four outcomes `SessionService.resolve` distinguishes, mapped onto §6's
 * two codes.
 *
 * `unknown` is `UNAUTHENTICATED`, not `SESSION_EXPIRED`: a token matching no row
 * never was a session here, so "your session ended" would be a false statement
 * to anyone holding a cookie from a database that has since been reset.
 * `expired` and `revoked` are both `SESSION_EXPIRED` — the frontend's next step
 * is identical, and splitting them would tell whoever holds a stolen token
 * whether the theft had been noticed.
 *
 * Not an oracle: reaching either arm requires already holding a token this
 * system issued, which an attacker guessing 256-bit values does not.
 */
function identityOf(resolution: SessionResolution): ResolvedIdentity {
  switch (resolution.outcome) {
    case 'resolved':
      return resolution.session;
    case 'unknown':
      throw unauthenticated();
    case 'expired':
    case 'revoked':
      throw new DomainError(
        ERROR_CODES.SESSION_EXPIRED,
        'The session has expired or been revoked.',
        401,
      );
    default: {
      // Exhaustiveness: a fifth outcome added to `SessionResolution` fails the
      // build here rather than falling into a default that admits it.
      const unhandled: never = resolution;
      throw new Error(`Unhandled session resolution: ${JSON.stringify(unhandled)}`);
    }
  }
}

/**
 * STAGE FOUR OF `architecture/backend.md` §3: CREDENTIAL -> `Principal`.
 *
 * It turns the cookie Task 6 issues into a `UserPrincipal` on the request and
 * refuses in three distinguishable ways. Nothing else: no organisation, no
 * membership, no permissions. `security/authentication.md` §1 makes
 * authentication answer *who*, and nothing about *which tenant* or *what they
 * may do* — that separation is what lets a multi-organisation consultant switch
 * organisations without signing in again. Ruling E: a guard that quietly starts
 * resolving tenants is how the two stages stop being separable.
 *
 * **The `Principal` is constructed, never parsed** (ruling D, carry-forward
 * ruling 16). `packages/contracts/src/principal.ts` publishes no Zod schema on
 * purpose, because `principalSchema.parse(req.body)` would mint a principal out
 * of attacker-controlled JSON. Every field below comes from what
 * `SessionService.resolve` returned and from nothing else.
 *
 * **`ApiKeyPrincipal` is not constructed here.** The union declares it so that
 * downstream authorization is written once (Task 2), but Phase 2 issues no API
 * keys; `assertUserPrincipal` throws where one would be reached, which is
 * correct until the arm exists.
 *
 * **What this guard cannot detect, stated because pretending otherwise is worse
 * than the gap.** Task 6's ruling 52: if Redis is unreachable at the moment a
 * session is revoked, the row is revoked and its cache entry cannot be
 * poisoned, so a warm entry can serve that session for up to
 * `SESSION_CACHE_TTL_SECONDS`. This guard calls `resolve` and has no way to see
 * that. A "read Postgres anyway" path would defeat the cache ADR-0005 spends to
 * avoid a per-request database read — on every request, to close a window a
 * short TTL already bounds. Not built, and recorded rather than quietly
 * accepted.
 */
@Injectable()
export class AuthenticationGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(SessionService) private readonly sessions: SessionResolver,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;

    const access = this.reflector.getAllAndOverride<AccessDeclaration | undefined>(
      ACCESS_METADATA_KEY,
      [context.getHandler(), context.getClass()],
    );

    // A public route skips this stage ENTIRELY, cookie parse included. A
    // browser attaches an expired or malformed session cookie to a login
    // request without being asked, and a public route that could 401 because of
    // one would be a route nobody could recover from — the way out of a bad
    // cookie is the login page, and the login page is public.
    if (access?.kind === 'public') return true;

    // `undefined` is unreachable in a booted application: `access-assertion.ts`
    // refuses to start on a route that declares nothing. It is treated as
    // "authentication required" rather than trusted, because the one way to
    // reach it is a route registered outside the metadata that assertion reads,
    // and that is not a route to hand a free pass to.
    const request = context.switchToHttp().getRequest<Request>();
    const token = readCookie(request.headers.cookie, SESSION_COOKIE_NAME);
    if (token === undefined) throw unauthenticated();

    const identity = identityOf(await this.sessions.resolve(token));

    if (identity.status === 'PENDING_MFA' && !this.allowsPendingMfa(context)) {
      // `security/authentication.md` §5: the pending session "can do nothing but
      // complete MFA". Task 6's ruling 50 closed the half where a pending
      // session could be *promoted* without evidence; this is the half that
      // constrains what it may *do*. A pending credential that can read
      // anything is the whole MFA bypass.
      throw new DomainError(
        ERROR_CODES.MFA_REQUIRED,
        'Multi-factor authentication must be completed before this request.',
        401,
      );
    }

    request.principal = { kind: 'user', userId: identity.userId, sessionId: identity.id };
    return true;
  }

  /**
   * **The handler only.** `@AllowPendingMfa()` is an exemption, and
   * `rate-limit.guard.ts` records what reading class-level metadata did to the
   * last exemption in this codebase: the decorator was narrowed to
   * `MethodDecorator`, but the guard still honoured a class-level
   * `@SetMetadata(...)`, so one line on a controller disabled every limit
   * beneath it. `reflector.get` against `getHandler()` cannot be widened that
   * way.
   */
  private allowsPendingMfa(context: ExecutionContext): boolean {
    return this.reflector.get<true>(ALLOW_PENDING_MFA_KEY, context.getHandler()) === true;
  }
}
