import { Module } from '@nestjs/common';
import type { ApiEnv } from '@sentinel/config';
import { MailModule } from '../../infrastructure/mail/mail.module.js';
import { PrismaModule } from '../../infrastructure/prisma/prisma.module.js';
import { RedisModule } from '../../infrastructure/redis/redis.module.js';
import { ENV, PRISMA } from '../../infrastructure/tokens.js';
import { AuditModule } from '../audit/audit.module.js';
import { AuthController } from './auth.controller.js';
import { AuthMailer } from './auth-mailer.js';
import {
  activeOrganizationLookup,
  type ActiveOrganizationLookup,
  type TenantTransactionBase,
} from './active-organization.store.js';
import { EmailVerificationService } from './email-verification.service.js';
import { LoginService } from './login.service.js';
import { MfaEnrolmentService } from './mfa-enrolment.service.js';
import { MfaVerificationService } from './mfa-verification.service.js';
import { LogoutService } from './logout.service.js';
import { PasswordChangeService } from './password-change.service.js';
import { PasswordResetService } from './password-reset.service.js';
import { RecoveryCodesService } from './recovery-codes.service.js';
import { RegistrationService } from './registration.service.js';
import { SessionDocumentService } from './session-document.service.js';
import {
  ACTIVE_ORGANIZATION_LOOKUP,
  ARGON2_PARAMETERS,
  BREACH_CHECK_OPTIONS,
  HIBP_RANGE_TRANSPORT,
  MFA_SECRET_KEY,
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
 * Password hashing, the breach check, single-use secret tokens, sessions, and
 * since Task 8 the registration and email-verification endpoints.
 *
 * **It registered no controller until Task 8, and that was deliberate.** The
 * four services here were built for the endpoint tasks that follow —
 * registration and email verification (Task 8), login (Task 9), password reset
 * (Task 10), invitation acceptance (Task 15) — and shipping a route before the
 * authentication guard existed (Task 7) would have meant an unguarded endpoint
 * standing for several tasks. `pnpm check:openapi` reported four routes for
 * exactly that long. `AuthController` arrives now that the guard, the CSRF
 * guard, the rate limiter and the boot-time access assertion are all in the
 * pipeline ahead of it. That check reported **seven** after Task 8, ten after
 * Task 9's login, logout and session routes, and thirteen after Task 10's
 * password reset and change.
 *
 * `ENV` and the logger come from the global `ConfigModule`. Neither
 * `PrismaModule` nor `RedisModule` is global — each exports its one token
 * explicitly — so both are imported here: `TokenService` and
 * `SessionRepository` touch tables, and `RedisSessionCache` is the only
 * consumer of `REDIS` in this module.
 *
 * `MailModule` and `AuditModule` are imported for the same reason: neither is
 * global, and `AuthMailer` needs `MAILER` while the two endpoint services need
 * `PlatformAuditService`. `AuditModule` provides that service with no Prisma
 * client of its own — it writes into the caller's transaction, which is what
 * `security/audit.md` §2 requires.
 */
@Module({
  imports: [PrismaModule, RedisModule, MailModule, AuditModule],
  controllers: [AuthController],
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
    {
      // THE ONE PLACE THE ENCRYPTION KEY IS DECODED. D2.
      //
      // Provided as bytes rather than as the base64 string, so no consumer has
      // to remember to decode it and no consumer can pass the wrong thing to
      // `createCipheriv`. A wrong-length value cannot reach here at all:
      // `apiEnvSchema` refuses the boot naming the variable, which is the whole
      // point of checking the length at config load rather than at first use.
      //
      // **`MfaEnrolmentGuard`'s `MFA_ENROLMENT_POLICY` is deliberately NOT
      // provided beside this** — D8's mechanism is registered nowhere, and
      // `require-mfa.spec.ts` asserts that against this file.
      provide: MFA_SECRET_KEY,
      inject: [ENV],
      useFactory: (env: ApiEnv): Buffer => Buffer.from(env.MFA_SECRET_ENCRYPTION_KEY, 'base64'),
    },
    // The port, so `SessionService` cannot reach an ioredis client directly.
    { provide: SESSION_CACHE, useClass: RedisSessionCache },
    {
      // THE ONE PLACE THE BASE PRISMA CLIENT REACHES THE ORGANISATION LOOKUP.
      //
      // `activeOrganizationLookup` closes over it to run
      // `withTenantTransaction`, which is what sets `app.organization_id` and
      // therefore what makes `Organization`'s row-level security policy admit
      // the read at all — measured, and recorded in that file. Exposing the
      // one question rather than the client means `SessionDocumentService`
      // cannot read an organisation it was not asked about.
      provide: ACTIVE_ORGANIZATION_LOOKUP,
      inject: [PRISMA],
      useFactory: (prisma: TenantTransactionBase): ActiveOrganizationLookup =>
        activeOrganizationLookup(prisma),
    },
    // The one place the real network transport is named. Every spec supplies
    // its own function instead, which is what keeps the suite hermetic
    // (ADR-0015) without any test-environment special case.
    { provide: HIBP_RANGE_TRANSPORT, useValue: fetchRangeTransport },
    PasswordService,
    BreachCheckService,
    TokenService,
    SessionRepository,
    SessionService,
    AuthMailer,
    RegistrationService,
    EmailVerificationService,
    LoginService,
    LogoutService,
    SessionDocumentService,
    PasswordResetService,
    PasswordChangeService,
    RecoveryCodesService,
    MfaEnrolmentService,
    MfaVerificationService,
  ],
  // `SessionRepository` is deliberately NOT exported. It is `SessionService`'s
  // Postgres access, and a consumer holding it could revoke a row without
  // poisoning the cache entry that would go on serving it.
  //
  // Neither are `AuthMailer`, `RegistrationService`, `EmailVerificationService`,
  // `PasswordResetService` or `PasswordChangeService`: they exist for this
  // module's own controller, and a consumer elsewhere holding one could create
  // an account, confirm an address or REPLACE A CREDENTIAL without going
  // through a rate-limited, audited route. The last of those is the sharpest —
  // both password services write to `Credential` and revoke sessions, and
  // neither has any business being reachable except through the two endpoints
  // that carry the rate-limit class and the audit row.
  //
  // Nor are the two MFA services or `RecoveryCodesService`, and the argument is
  // sharper still: a consumer holding `MfaEnrolmentService` could DISABLE a
  // second factor without going through the route that demands the current
  // password, and a consumer holding `MfaVerificationService` could promote a
  // pending session without the rate limit or the five-attempt lock.
  exports: [PasswordService, BreachCheckService, TokenService, SessionService],
})
export class AuthModule {}
