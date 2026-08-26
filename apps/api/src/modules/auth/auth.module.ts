import { Module } from '@nestjs/common';
import type { ApiEnv } from '@sentinel/config';
import { PrismaModule } from '../../infrastructure/prisma/prisma.module.js';
import { RedisModule } from '../../infrastructure/redis/redis.module.js';
import { ENV } from '../../infrastructure/tokens.js';
import {
  ARGON2_PARAMETERS,
  BREACH_CHECK_OPTIONS,
  HIBP_RANGE_TRANSPORT,
  SECRET_TOKEN_TTL_SECONDS,
  SESSION_CACHE,
  SESSION_POLICY,
} from './auth.tokens.js';
import {
  type BreachCheckOptions,
  BreachCheckService,
  fetchRangeTransport,
} from './breach-check.service.js';
import { type Argon2Parameters, PasswordService } from './password.service.js';
import { RedisSessionCache } from './session.cache.js';
import { SessionRepository } from './session.repository.js';
import { type SessionPolicy, SessionService } from './session.service.js';
import { type SecretTokenTtlSeconds, TokenService } from './token.service.js';

/**
 * Password hashing, the breach check, single-use secret tokens, and sessions.
 *
 * **This module has no controller and registers no route, deliberately.** It
 * exists to provide four services to the endpoint tasks that follow —
 * registration and email verification (Task 8), login (Task 9), password reset
 * (Task 10), and invitation acceptance (Task 15). Shipping a
 * route here would ship an unauthenticated, unguarded endpoint six tasks before
 * the guard that protects it exists (Task 7). `pnpm check:openapi` still
 * reports four routes with this module registered, and that is the check that
 * holds this property.
 *
 * `ENV` and the logger come from the global `ConfigModule`. Neither
 * `PrismaModule` nor `RedisModule` is global — each exports its one token
 * explicitly — so both are imported here: `TokenService` and
 * `SessionRepository` touch tables, and `RedisSessionCache` is the only
 * consumer of `REDIS` in this module.
 */
@Module({
  imports: [PrismaModule, RedisModule],
  providers: [
    {
      provide: ARGON2_PARAMETERS,
      inject: [ENV],
      useFactory: (env: ApiEnv): Argon2Parameters => ({
        memoryCostKib: env.PASSWORD_ARGON2_MEMORY_KIB,
        timeCost: env.PASSWORD_ARGON2_TIME_COST,
        parallelism: env.PASSWORD_ARGON2_PARALLELISM,
      }),
    },
    {
      provide: BREACH_CHECK_OPTIONS,
      inject: [ENV],
      useFactory: (env: ApiEnv): BreachCheckOptions => ({
        enabled: env.PASSWORD_BREACH_CHECK_ENABLED,
        rangeUrl: env.PASSWORD_BREACH_CHECK_RANGE_URL,
        timeoutMs: env.PASSWORD_BREACH_CHECK_TIMEOUT_MS,
      }),
    },
    {
      // All three of §6's kinds, including the invitation TTL that only Task 15
      // reads. Exposed here rather than only the two `VerificationToken` knows
      // about, so the configured value is reachable instead of dead weight.
      provide: SECRET_TOKEN_TTL_SECONDS,
      inject: [ENV],
      useFactory: (env: ApiEnv): SecretTokenTtlSeconds => ({
        EMAIL_VERIFICATION: env.TOKEN_TTL_EMAIL_VERIFICATION_SECONDS,
        PASSWORD_RESET: env.TOKEN_TTL_PASSWORD_RESET_SECONDS,
        INVITATION: env.TOKEN_TTL_INVITATION_SECONDS,
      }),
    },
    {
      // §3 and §5's five durations, resolved once at boot rather than read from
      // `ApiEnv` inside the service. That is what lets a spec construct a
      // policy the configuration layer would refuse — an already-elapsed
      // lifetime — and test the absolute and idle clocks independently.
      provide: SESSION_POLICY,
      inject: [ENV],
      useFactory: (env: ApiEnv): SessionPolicy => ({
        absoluteLifetimeSeconds: env.SESSION_ABSOLUTE_LIFETIME_SECONDS,
        rememberMeLifetimeSeconds: env.SESSION_REMEMBER_ME_LIFETIME_SECONDS,
        idleTimeoutSeconds: env.SESSION_IDLE_TIMEOUT_SECONDS,
        pendingMfaLifetimeSeconds: env.SESSION_PENDING_MFA_LIFETIME_SECONDS,
        cacheTtlSeconds: env.SESSION_CACHE_TTL_SECONDS,
      }),
    },
    // The port, so `SessionService` cannot reach an ioredis client directly.
    { provide: SESSION_CACHE, useClass: RedisSessionCache },
    // The one place the real network transport is named. Every spec supplies
    // its own function instead, which is what keeps the suite hermetic
    // (ADR-0015) without any test-environment special case.
    { provide: HIBP_RANGE_TRANSPORT, useValue: fetchRangeTransport },
    PasswordService,
    BreachCheckService,
    TokenService,
    SessionRepository,
    SessionService,
  ],
  // `SessionRepository` is deliberately NOT exported. It is `SessionService`'s
  // Postgres access, and a consumer holding it could revoke a row without
  // poisoning the cache entry that would go on serving it.
  exports: [PasswordService, BreachCheckService, TokenService, SessionService],
})
export class AuthModule {}
