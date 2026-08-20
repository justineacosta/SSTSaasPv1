import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ERROR_CODES } from '@sentinel/contracts';
import type { Logger } from '@sentinel/observability';
import type { Redis } from 'ioredis';
import { LOGGER, REDIS } from '../../infrastructure/tokens.js';
import { RATE_LIMIT_METADATA_KEY } from '../decorators/rate-limit.decorator.js';
import { DomainError } from '../errors/domain-error.js';
import {
  RATE_LIMIT_CLASSES,
  RATE_LIMIT_SCOPES,
  type RateLimitClass,
  type RateLimitClassConfig,
  type RateLimitScope,
} from './rate-limit.config.js';
import { consumeSlidingWindow, slidingWindowKey, type WindowDecision } from './sliding-window.js';

/**
 * The request properties the guard keys on.
 *
 * `principalId` and `organizationId` are set by authentication, which arrives in
 * Phase 2 — in Phase 1 they are always absent, and the guard's behaviour when
 * they are absent is therefore a shipped, tested property rather than something
 * discovered later. See `resolveIdentifier`.
 */
interface KeyableRequest {
  ip?: string | undefined;
  socket?: { remoteAddress?: string | undefined } | undefined;
  principalId?: string | undefined;
  organizationId?: string | undefined;
}

interface HeaderResponse {
  setHeader(name: string, value: string | number): void;
}

/**
 * Resolves the identifier a scope is keyed by, or `undefined` when this phase
 * cannot know it.
 *
 * The IP comes from `request.ip`, which is Express's view of the connection.
 * With `trust proxy` disabled — the default, and what this application ships —
 * that is the socket's peer address and a client-supplied `X-Forwarded-For` has
 * no effect on it. That matters more than it looks: if the header were trusted
 * here, rotating it would mint a fresh bucket per request and per-IP limiting
 * would be decorative. When a real load balancer is put in front of this API,
 * enabling `trust proxy` is not enough on its own — the deployment must also
 * guarantee that the proxy *overwrites* rather than appends to the header, or
 * the same bypass returns through the front door. See abuse-prevention.md §1.
 */
function resolveIdentifier(scope: RateLimitScope, request: KeyableRequest): string | undefined {
  switch (scope) {
    case 'perIp':
      return request.ip ?? request.socket?.remoteAddress;
    case 'perPrincipal':
      return request.principalId;
    case 'perOrganization':
      return request.organizationId;
  }
}

/** The window closest to refusing, which is the one whose numbers a client needs. */
function tightest(decisions: readonly WindowDecision[]): WindowDecision | undefined {
  return decisions.reduce<WindowDecision | undefined>((worst, decision) => {
    if (worst === undefined) return decision;
    if (!decision.allowed && worst.allowed) return decision;
    if (decision.allowed !== worst.allowed) return worst;
    return decision.remaining < worst.remaining ? decision : worst;
  }, undefined);
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;

    const className =
      this.reflector.getAllAndOverride<RateLimitClass>(RATE_LIMIT_METADATA_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? 'generalSession';

    // Widened to the interface deliberately. `RATE_LIMIT_CLASSES` is
    // `as const satisfies`, so each entry keeps its literal type and only the
    // scopes it actually declares — which means indexing one by a scope name it
    // does not have is a type error rather than the `undefined` this loop is
    // written to expect.
    const config: RateLimitClassConfig = RATE_LIMIT_CLASSES[className];
    const http = context.switchToHttp();
    const request = http.getRequest<KeyableRequest>();
    const response = http.getResponse<HeaderResponse>();
    const now = Date.now();

    const decisions: WindowDecision[] = [];
    let declared = 0;

    try {
      for (const scope of RATE_LIMIT_SCOPES) {
        const window = config[scope];
        if (window === undefined) continue;
        declared += 1;

        const identifier = resolveIdentifier(scope, request);
        if (identifier === undefined) continue;

        decisions.push(
          await consumeSlidingWindow(
            this.redis,
            slidingWindowKey(className, scope, identifier),
            window,
            now,
          ),
        );
      }
    } catch (error) {
      // A limiter that has silently stopped limiting is worth knowing about,
      // whichever way it fails — so this logs at warn in both directions, not
      // only when it refuses.
      this.logger.warn(
        { err: error, rateLimitClass: className, failMode: config.failMode },
        'Rate limit backend unavailable',
      );
      return this.applyFailMode(config.failMode, className);
    }

    if (declared > 0 && decisions.length === 0) {
      // Every declared scope was unresolvable. Skipping them silently would
      // leave a fail-closed class — `invitations` and `scanCreate` declare only
      // `perOrganization` — with no limit at all, which is the exact opposite
      // of what its failMode asks for. Unreachable in Phase 1, which is
      // precisely why it must already be right: the first `perOrganization`
      // endpoint ships in Phase 6.
      //
      // Logged at warn only when the outcome is a refusal. A fail-open class
      // whose principal is unknown is the *normal* state of every request until
      // authentication ships in Phase 2, and a warn per request would be a log
      // flood that trains operators to ignore the channel.
      const message = 'Rate limit scope could not be resolved';
      const bindings = { rateLimitClass: className, failMode: config.failMode };
      if (config.failMode === 'closed') this.logger.warn(bindings, message);
      else this.logger.debug(bindings, message);

      return this.applyFailMode(config.failMode, className);
    }

    const worst = tightest(decisions);
    if (worst === undefined) return true;

    // Headers on every response, allowed or refused — a client can only pace
    // itself if it is told where it stands before it is cut off.
    // abuse-prevention.md §1.
    response.setHeader('RateLimit-Limit', worst.limit);
    response.setHeader('RateLimit-Remaining', worst.remaining);
    response.setHeader('RateLimit-Reset', worst.resetSeconds);

    if (!worst.allowed) {
      response.setHeader('Retry-After', worst.resetSeconds);
      throw new DomainError(
        ERROR_CODES.RATE_LIMITED,
        'Too many requests. Try again shortly.',
        429,
        {
          retryAfterSeconds: worst.resetSeconds,
        },
      );
    }

    return true;
  }

  private applyFailMode(failMode: 'open' | 'closed', className: RateLimitClass): boolean {
    if (failMode === 'open') return true;
    throw new DomainError(
      ERROR_CODES.RATE_LIMITED,
      'Too many requests. Try again shortly.',
      429,
      // No `retryAfterSeconds`: there is no window to read one from, and
      // inventing a number would tell the caller something this code does not
      // know. The class is included so an operator reading the log can tell a
      // real breach from a backend outage.
      { rateLimitClass: className },
    );
  }
}
