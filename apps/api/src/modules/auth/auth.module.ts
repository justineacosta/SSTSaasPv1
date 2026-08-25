import { Module } from '@nestjs/common';
import type { ApiEnv } from '@sentinel/config';
import { ENV } from '../../infrastructure/tokens.js';
import { ARGON2_PARAMETERS, BREACH_CHECK_OPTIONS, HIBP_RANGE_TRANSPORT } from './auth.tokens.js';
import {
  type BreachCheckOptions,
  BreachCheckService,
  fetchRangeTransport,
} from './breach-check.service.js';
import { type Argon2Parameters, PasswordService } from './password.service.js';

/**
 * Password hashing and the breach check.
 *
 * **This module has no controller and registers no route, deliberately.** It
 * exists to provide two services to the endpoint tasks that follow —
 * registration (Task 8), login (Task 9), password reset (Task 10). Shipping a
 * route here would ship an unauthenticated, unguarded endpoint six tasks before
 * the guard that protects it exists (Task 7). `pnpm check:openapi` still
 * reports four routes with this module registered, and that is the check that
 * holds this property.
 *
 * `ENV` and the logger come from the global `ConfigModule`, so there is nothing
 * to import here.
 */
@Module({
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
    // The one place the real network transport is named. Every spec supplies
    // its own function instead, which is what keeps the suite hermetic
    // (ADR-0015) without any test-environment special case.
    { provide: HIBP_RANGE_TRANSPORT, useValue: fetchRangeTransport },
    PasswordService,
    BreachCheckService,
  ],
  exports: [PasswordService, BreachCheckService],
})
export class AuthModule {}
