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
