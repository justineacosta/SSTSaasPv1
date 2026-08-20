import { SetMetadata } from '@nestjs/common';
import type { RateLimitClass } from '../guards/rate-limit.config.js';

export const RATE_LIMIT_METADATA_KEY = 'sentinel:rate-limit';

/**
 * Declares which limit class from abuse-prevention.md §1 governs a route.
 *
 * A route with no declaration falls to `generalSession`, which is the table's
 * own default for the general API rather than "unlimited": forgetting the
 * decorator degrades to the general limit, it does not remove limiting.
 *
 * The class name is typed against `RATE_LIMIT_CLASSES`, so a typo is a compile
 * error rather than a guard that silently never matches.
 */
export const RateLimit = (className: RateLimitClass): MethodDecorator & ClassDecorator =>
  SetMetadata<string, RateLimitClass>(RATE_LIMIT_METADATA_KEY, className);

export const RATE_LIMIT_EXEMPT_KEY = 'sentinel:rate-limit-exempt';

/**
 * Declares a route the limiter must not touch at all.
 *
 * This exists for exactly one reason and should keep only one user: the
 * liveness probe. `monitoring.md` §5 requires liveness to check the process and
 * nothing else, because a liveness probe that depends on a backing service
 * restarts every instance at once during a blip and turns a hiccup into an
 * outage. A rate-limit guard is a backing-service dependency — it reaches
 * Redis — so a limited liveness route would acquire exactly the dependency the
 * probe is defined not to have.
 *
 * Without this the property held only by accident: `generalSession` happens to
 * declare no scope that resolves on an unauthenticated request, so the guard
 * returned before touching Redis. Adding `perIp` to that class — which §1's own
 * rationale ("an unauthenticated flood [caught] by the IP limit") arguably
 * calls for — would silently give liveness a Redis dependency with no test
 * failing. `rate-limit.integration.spec.ts` asserts the probe issues no
 * Redis command at all.
 *
 * Do not reach for this to make a route cheaper. Every other route, including
 * readiness, stays on the normal path.
 *
 * **`MethodDecorator` only, deliberately.** As a class decorator this would be
 * a one-line kill switch for the platform's only abuse control: the guard reads
 * the handler and the class and takes the first *defined* value, and
 * `SetMetadata` offers no way to say "not exempt", so a `@RateLimit()` on a
 * handler underneath could not opt back in. One line at the top of a controller
 * would silently disable every limit in it. Narrowing the type makes that a
 * compile error.
 */
export const RateLimitExempt = (): MethodDecorator =>
  SetMetadata<string, true>(RATE_LIMIT_EXEMPT_KEY, true);
