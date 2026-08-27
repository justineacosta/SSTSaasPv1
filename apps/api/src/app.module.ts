import { Module } from '@nestjs/common';
import { APP_GUARD, DiscoveryModule } from '@nestjs/core';
import { AuthenticationGuard } from './common/guards/authentication.guard.js';
import { CsrfGuard } from './common/guards/csrf.guard.js';
import { RateLimitGuard } from './common/guards/rate-limit.guard.js';
import { ConfigModule } from './infrastructure/config/config.module.js';
import { MailModule } from './infrastructure/mail/mail.module.js';
import { PrismaModule } from './infrastructure/prisma/prisma.module.js';
import { RedisModule } from './infrastructure/redis/redis.module.js';
import { StorageModule } from './infrastructure/storage/storage.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { OpenApiModule } from './openapi/openapi.module.js';

/**
 * The composition root.
 *
 * The cross-cutting middleware chain is deliberately NOT registered here.
 * `MiddlewareConsumer.forRoutes()` resolves its paths *under the global prefix*,
 * so `{ path: '*splat' }` covered only `/api/<seg>/**` and `/health/<seg>/**` —
 * `/`, `/a/b`, `/healthz` and a body-parse failure all answered with no security
 * headers and no request ID. Both middlewares are now registered with
 * `app.use()` in `configureApp` (`app-setup.ts`), which puts them ahead of
 * Nest's body parser and outside the prefix entirely.
 * security/transport-and-headers.md §2, architecture/backend.md §3.
 */
@Module({
  // `DiscoveryModule` is what lets the boot-time access assertion enumerate
  // every controller. Imported here rather than only inside `OpenApiModule`
  // because the assertion is a property of the whole application, and a
  // security check that works only while some unrelated module happens to be
  // imported is a check waiting to be switched off by a refactor.
  // architecture/backend.md §3.
  imports: [
    DiscoveryModule,
    ConfigModule,
    PrismaModule,
    RedisModule,
    StorageModule,
    // Registered although nothing injects `MAILER` yet. Task 5 ships the port,
    // the adapter and seven templates for Tasks 8, 10, 11 and 15; wiring it into
    // the composition root now means the factory runs at every boot and in
    // every integration spec, so a mailer that could not be constructed — or
    // that reached the network on the way up, which ruling 49 forbids — fails
    // loudly here rather than at the first send, six tasks later.
    MailModule,
    AuthModule,
    HealthModule,
    OpenApiModule,
  ],
  providers: [
    // Global, not opt-in. A limiter a route has to remember to ask for is a
    // limiter that is missing from the route nobody thought about — and the
    // table in abuse-prevention.md §1 has a default for the general API
    // precisely so there is an answer for every endpoint. `@RateLimit()`
    // narrows the class; its absence means `generalSession`, not "unlimited".
    { provide: APP_GUARD, useClass: RateLimitGuard },
    // ORDER IS ARRAY ORDER, AND NOTHING ELSE MAKES IT VISIBLE. Nest runs global
    // guards in the order their providers are declared here, so this array is
    // the pipeline of architecture/backend.md §3 rows 3, 4 and 6.
    // `app.module.spec.ts` asserts it, because a reordering is a one-line diff
    // with no other symptom.
    //
    // **Rate limit before authenticate** (Task 7's ruling A, backend.md §3's
    // own table). An unauthenticated flood carrying a garbage cookie would
    // otherwise buy a Redis read and a Postgres read each before anything
    // refused it. The cost of this order is recorded rather than fixed:
    // `generalSession` keys on `principalSource: 'authenticated'`, which reads
    // `request.principalId` — a field the limiter reads before this guard could
    // have set it, so that scope stays unresolvable and the limiter's own
    // `unresolvedWarned` path is what makes it visible at runtime. Splitting the
    // limiter into an early per-IP stage and a late per-principal stage is the
    // real fix and is not this task's.
    { provide: APP_GUARD, useClass: AuthenticationGuard },
    // **CSRF after authenticate**, so it runs on a request whose credential has
    // already been established, and so an unauthenticated caller gets 401
    // rather than 403 — one refusal, describing the first thing that was wrong.
    { provide: APP_GUARD, useClass: CsrfGuard },
  ],
})
export class AppModule {}
