import { createHash } from 'node:crypto';
import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ERROR_CODES } from '@sentinel/contracts';
import type { Logger } from '@sentinel/observability';
import type { Redis } from 'ioredis';
import { LOGGER, REDIS } from '../../infrastructure/tokens.js';
import {
  RATE_LIMIT_EXEMPT_KEY,
  RATE_LIMIT_METADATA_KEY,
} from '../decorators/rate-limit.decorator.js';
import { DomainError } from '../errors/domain-error.js';
import {
  RATE_LIMIT_CLASSES,
  RATE_LIMIT_SCOPE_PHASES,
  RATE_LIMIT_SCOPES,
  type RateLimitClass,
  type RateLimitClassConfig,
  type RateLimitPhase,
  type RateLimitScope,
} from './rate-limit.config.js';
import { consumeSlidingWindow, slidingWindowKey, type WindowDecision } from './sliding-window.js';

/**
 * The request properties the guard keys on.
 *
 * **`principalId` is written by nothing.** Carry-forward rulings 55 and 90: the
 * edge stage runs before authentication, so `generalSession`'s per-principal
 * limit resolves nothing on every request. Still open, and
 * `RATE_LIMIT_SCOPE_PHASES` records why Task 15 did not close it while it was
 * building the stage that could.
 *
 * **`organizationId` is written by `TenantContextGuard`, and only the `'tenant'`
 * phase reads it.** Writing it earlier would be pointless — the edge stage has
 * already run — which is the prohibition `authentication.guard.ts` states.
 */
interface KeyableRequest {
  ip?: string | undefined;
  socket?: { remoteAddress?: string | undefined } | undefined;
  principalId?: string | undefined;
  organizationId?: string | undefined;
  body?: unknown;
}

/**
 * IPv4-mapped IPv6 (`::ffff:1.2.3.4`) and plain `1.2.3.4` are the same client
 * and must be the same bucket. They arrive as different strings the moment
 * `trust proxy` is enabled and forwarded addresses start showing up in v4 form
 * alongside directly-connected mapped-v6 ones.
 */
export function normaliseIp(address: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/iu.exec(address);
  if (mapped?.[1] !== undefined) return mapped[1];

  const lower = address.toLowerCase();
  if (!lower.includes(':')) return lower;

  // IPv6 is bucketed by /64, not by full address. A single host is routinely
  // given a whole /64 — that is 1.8e19 addresses, so a per-address bucket is no
  // bound at all, and every per-IP limit in the table would be bypassable at
  // zero cost by anyone with a v6 allocation. The /64 is the smallest unit an
  // operator is normally delegated, so it is the smallest unit that behaves
  // like "one client". A shared /64 (some mobile carriers, some hosting) means
  // neighbours share a bucket; that is the same trade IPv4 NAT already forces,
  // and the wrong side of it is unbounded.
  // No zone-index strip. A zone (`%eth0`) is only ever attached to the last
  // hextet, and the /64 slice below keeps the first four — so it can never
  // reach the bucket key. The strip that used to be here was unreachable, and
  // the test that claimed to cover it passed with the line deleted.
  return `${expandIpv6Prefix(lower)}::/64`;
}

/** The first four hextets of an IPv6 address, `::`-expansion included. */
function expandIpv6Prefix(address: string): string {
  const [head = '', tail = ''] = address.split('::', 2);
  const headParts = head === '' ? [] : head.split(':');
  const tailParts = tail === '' ? [] : tail.split(':');
  const missing = Math.max(0, 8 - headParts.length - tailParts.length);
  const full = address.includes('::')
    ? [...headParts, ...Array<string>(missing).fill('0'), ...tailParts]
    : headParts;
  return full
    .slice(0, 4)
    .map((part) => (part === '' ? '0' : part.replace(/^0+(?=.)/u, '')))
    .join(':');
}

/**
 * Hashed, never raw. An email address is the identifier for the per-account
 * classes, and a raw one would sit in a Redis key — visible to anything that
 * can run `KEYS`, and to anyone reading a slow-log or a memory dump. Truncated
 * because a rate-limit bucket needs distinctness, not preimage resistance.
 *
 * What this does **not** do, stated plainly so nobody over-reads it: an
 * unsalted digest is a confirmation oracle. Someone who can list the keys and
 * guesses an address can check the guess in one hash. It keeps addresses out of
 * plaintext; it does not keep them secret from an attacker who already has a
 * candidate list. An HMAC under a server secret would close that, at the cost
 * of making every bucket unrecoverable across a secret rotation and requiring
 * the secret in a code path that must not fail. Deliberately not taken for a
 * rate-limit bucket; revisit if the key space ever holds something more
 * sensitive than an address.
 *
 * The digest is deliberately *unsalted per process*: a per-instance salt would
 * split one account's window across instances and multiply the effective limit
 * by the instance count, which is a security defect rather than a hardening.
 */
export function normaliseAccountIdentifier(value: string): string {
  // NFKC before case folding, so the same address written in NFC and NFD is one
  // bucket rather than two. **This must stay identical to whatever the Phase 2
  // account lookup does.** If the lookup normalises more aggressively than the
  // guard, two spellings the lookup treats as one account get two limit buckets
  // and the per-account limit is halved — silently, which is this defect
  // class's signature. One function, used by both, with a test.
  return value.normalize('NFKC').trim().toLowerCase();
}

function hashIdentifier(value: string): string {
  return createHash('sha256')
    .update(normaliseAccountIdentifier(value))
    .digest('base64url')
    .slice(0, 22);
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
export function resolveIdentifier(
  scope: RateLimitScope,
  request: KeyableRequest,
  config: RateLimitClassConfig,
): string | undefined {
  switch (scope) {
    case 'perIp': {
      const address = request.ip ?? request.socket?.remoteAddress;
      return address === undefined ? undefined : normaliseIp(address);
    }
    case 'perPrincipal': {
      const source = config.principalSource ?? 'authenticated';
      if (source === 'authenticated') return request.principalId;

      // Guards run after the body parser, so the field is available here. A
      // non-string, an empty string, or a missing body resolves to nothing
      // rather than to a shared `"undefined"` bucket that every malformed
      // request would pile into.
      const body: unknown = request.body;
      if (typeof body !== 'object' || body === null) return undefined;
      const raw = (body as Record<string, unknown>)[source.bodyField];
      if (typeof raw !== 'string' || raw.trim() === '') return undefined;
      return hashIdentifier(raw);
    }
    case 'perOrganization':
      return request.organizationId;
  }
}

/**
 * The window whose numbers a client needs: the refusal if there is one,
 * otherwise the one with the least room left.
 *
 * There is at most one refusal to choose between, because evaluation stops at
 * the first — so `Retry-After` describes **the scope that refused**, not
 * necessarily the longest wait the request faces. A client refused by a nearly
 * expired IP window can obey that header, arrive, and be refused again by an
 * account window it never reached. Making the header describe the true worst
 * case would mean evaluating every scope read-only and committing only if all
 * allowed — a real design, and a different one, since it also changes what
 * "charged" means. Recorded here rather than half-built: an unreachable
 * tie-break branch pretending to solve it is worse than an honest limitation.
 */
function tightest(decisions: readonly WindowDecision[]): WindowDecision | undefined {
  return decisions.reduce<WindowDecision | undefined>((worst, decision) => {
    if (worst === undefined) return decision;
    if (decision.allowed !== worst.allowed) return decision.allowed ? worst : decision;
    return decision.remaining < worst.remaining ? decision : worst;
  }, undefined);
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  /**
   * The last **observed** state of the backend, driving state-change logging.
   *
   * "Observed" is load-bearing: it only changes when a command actually reached
   * Redis, or actually failed to. A request that resolved no scope issues no
   * command and therefore learns nothing, so it must not clear the flag — doing
   * so produced alternating "unavailable"/"recovered" lines during a single
   * ongoing outage, and a false all-clear closes incidents that are open.
   *
   * The cost of that correctness, stated because it is not obvious: a recovery
   * no request observed is never logged, so an outage → unobserved recovery →
   * second outage sequence emits one "unavailable" and no "recovered". The log
   * describes what this process saw, not what happened. Today that is most of
   * the traffic, because nothing resolves a scope before Phase 2.
   */
  private backendDown = false;

  /**
   * `class:scope` pairs already warned about; see the warn below.
   *
   * Keyed by the pair, not by the class. Keying by class alone meant the first
   * unresolvable scope burned the class's only warning — and on `login`,
   * `passwordReset` and `emailVerificationResend` that first miss is free for
   * any unauthenticated caller to trigger within seconds of boot, by posting a
   * body with no `email`. A genuine wiring defect on the *other* scope of the
   * same class would then never be reported for the life of the process, which
   * is precisely the signal this warning exists to carry.
   *
   * Bounded by the class table times three scopes, and every component comes
   * from route metadata, so nothing a caller controls can grow it.
   */
  private readonly unresolvedWarned = new Set<string>();

  /**
   * Which stage of the pipeline this instance is. `'edge'` here and `'tenant'`
   * in the subclass below — a field rather than a constructor parameter so a
   * Nest provider cannot be registered with the wrong one by passing an extra
   * argument, and so `app.module.ts` names the phase by naming the class.
   */
  protected readonly phase: RateLimitPhase = 'edge';

  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;

    // Checked before anything else, and before any Redis call: see
    // `RateLimitExempt`. Liveness must reach no backing service.
    //
    // **The handler only, deliberately.** Narrowing the decorator's type stopped
    // `@RateLimitExempt()` being written on a class, but it did not stop the
    // guard from *honouring* class-level metadata — and `RATE_LIMIT_EXEMPT_KEY`
    // is exported, so one `@SetMetadata(RATE_LIMIT_EXEMPT_KEY, true)` on a
    // controller still disabled every limit beneath it, including a fail-closed
    // class during a Redis outage. Since no supported decorator can set this at
    // class level, reading the class was dead for legitimate use and live only
    // for the bypass. An exemption is a per-route decision and nothing else.
    const exempt = this.reflector.get<true>(RATE_LIMIT_EXEMPT_KEY, context.getHandler());
    if (exempt === true) return true;

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

    // THE SCOPES THIS PASS OWNS, AND NOTHING ELSE. See
    // `RATE_LIMIT_SCOPE_PHASES`: the limiter is registered twice and every
    // scope belongs to exactly one phase, so no window is charged twice for
    // one request.
    //
    // **`declared` below counts scopes in THIS phase**, and that is what keeps
    // the fail-closed branch honest rather than a separate early return. A
    // class with no scope in this phase declares nothing here, so
    // `declared > 0 && decisions.length === 0` is false and the request passes
    // without a Redis command — which is the difference between "this stage has
    // nothing to say" and "every declared scope was unresolvable". `invitations`
    // is exactly that shape: no scope in `'edge'`, one in `'tenant'`.
    //
    // An early `if (no scope in this phase) return true` was written here first
    // and **deleting it left all 29 tests green** — it was already implied by
    // the line below. Removed rather than kept with a comment claiming it was
    // load-bearing, which is carry-forward ruling 103's shape.
    const scopes = RATE_LIMIT_SCOPES.filter(
      (scope) => RATE_LIMIT_SCOPE_PHASES[scope] === this.phase,
    );

    const decisions: WindowDecision[] = [];
    const unresolved: RateLimitScope[] = [];
    let declared = 0;

    try {
      for (const scope of scopes) {
        const window = config[scope];
        if (window === undefined) continue;
        declared += 1;

        const identifier = resolveIdentifier(scope, request, config);
        if (identifier === undefined) {
          unresolved.push(scope);
          continue;
        }

        const decision = await consumeSlidingWindow(
          this.redis,
          slidingWindowKey(className, scope, identifier),
          window,
          now,
        );
        decisions.push(decision);

        // Stop at the first refusal. Continuing would charge the request
        // against every remaining scope's window even though it is already
        // being rejected — so a single IP, once its own per-IP limit had
        // closed, could go on burning the per-account budget of any account it
        // named, and lock out arbitrarily many of them. The per-IP cap exists
        // precisely to bound the damage one address can do.
        if (!decision.allowed) break;
      }
    } catch (error) {
      // A limiter that has silently stopped limiting is worth knowing about,
      // whichever way it fails — so this logs in both directions, not only when
      // it refuses. On the state CHANGE, though, not per request: during an
      // outage this guard runs on every request, and ioredis is already
      // emitting its own reconnect warnings underneath. A line per request
      // would bury the one line that matters and train an operator to filter
      // the channel out.
      if (!this.backendDown) {
        this.backendDown = true;
        this.logger.warn(
          { err: error, rateLimitClass: className, failMode: config.failMode },
          'Rate limit backend unavailable; limits are now applying their fail mode',
        );
      }
      return this.applyFailMode(config.failMode, className);
    }

    // Cleared only when a command actually reached Redis. Resetting on any
    // request that got this far would clear it on requests that issued no
    // command at all — every unauthenticated request to a `generalSession`
    // route, which is most traffic today — and produce a stream of "recovered"
    // lines during an outage that is still ongoing. A false all-clear is worse
    // than the per-request warn this replaced: it closes incidents that are
    // open.
    if (this.backendDown && decisions.length > 0) {
      this.backendDown = false;
      this.logger.warn({ rateLimitClass: className }, 'Rate limit backend recovered');
    }

    if (unresolved.length > 0 && decisions.length > 0 && config.failMode === 'closed') {
      // A declared scope that resolved to nothing, on a class whose failMode
      // says it would rather refuse than guess. Silence here is what let the
      // per-account limits go missing while the per-IP one kept answering: the
      // route refused at the wrong limit, advertised that limit in its headers,
      // and nothing said the other control was absent.
      //
      // Once per class per process, not once per request. This condition cannot
      // distinguish a **wiring defect** — a class keyed off something nothing
      // ever populates, which is what it exists to catch and which is permanent
      // — from a **client that sent a body without the field**, which is
      // ordinary traffic anyone can generate at will. Warning on every
      // occurrence would let any unauthenticated caller flood the channel and
      // bury the wiring defect underneath, which is the same anti-pattern the
      // fail-open branch below is written to avoid. The first occurrence of
      // each class-and-scope pair carries the whole signal: which limit is not
      // being applied, and on what, is all an operator needs to find it.
      const unreported = unresolved.filter(
        (scope) => !this.unresolvedWarned.has(`${className}:${scope}`),
      );
      if (unreported.length > 0) {
        for (const scope of unreported) this.unresolvedWarned.add(`${className}:${scope}`);
        this.logger.warn(
          { rateLimitClass: className, unresolvedScopes: unreported },
          'Rate limit scope declared but not resolvable; that limit is not being applied',
        );
      }
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

/**
 * THE SECOND STAGE OF THE LIMITER, RUN AFTER THE TENANT IS RESOLVED AND THE
 * PERMISSION CHECKED.
 *
 * The same guard, the same table, the same Redis keys — only the phase differs,
 * so there is no second implementation of a limiter to drift from the first.
 * `RATE_LIMIT_SCOPE_PHASES` is the whole of the difference and it is the one
 * place to read.
 *
 * **Why it exists.** `perOrganization`'s identifier is
 * `Session.activeOrganizationId`, resolved by `TenantContextGuard`, and the
 * edge stage runs before authentication — so a fail-closed class whose only
 * scope is `perOrganization` refused every request with 429. Phase 1 shipped
 * that as a tested property because no route carried such a class;
 * `POST /organizations/:id/invitations` is the first that does.
 *
 * **Why it sits AFTER `AuthorizationGuard` rather than immediately after the
 * tenant resolves.** A per-organisation window is a budget belonging to the
 * organisation — 50 invitations a day, `abuse-prevention.md` §1 — and a request
 * the organisation's own authorization rules refuse must not spend it. Placed
 * any earlier, a `GUEST` who cannot invite anybody could still exhaust their
 * organisation's daily invitation budget by posting until it was gone. The edge
 * stage keeps the cheap-and-early property for the scopes that have it; this
 * one deliberately pays for authentication, tenant resolution and the
 * permission check first, because what it is protecting is not this process's
 * CPU but a tenant's quota.
 *
 * Registered as its own `APP_GUARD` provider in `app.module.ts`, which is where
 * the order is visible. It is a distinct class rather than a second
 * registration of `RateLimitGuard` with a different argument because Nest
 * resolves an `APP_GUARD` by class, so two registrations of one class would be
 * one instance in two positions, running the same phase twice.
 */
@Injectable()
export class TenantRateLimitGuard extends RateLimitGuard {
  protected override readonly phase: RateLimitPhase = 'tenant';

  constructor(
    @Inject(Reflector) reflector: Reflector,
    @Inject(REDIS) redis: Redis,
    @Inject(LOGGER) logger: Logger,
  ) {
    super(reflector, redis, logger);
  }
}
