import { Module } from '@nestjs/common';
import { APP_GUARD, DiscoveryModule } from '@nestjs/core';
import type { ApiEnv } from '@sentinel/config';
import { AuthenticationGuard } from './common/guards/authentication.guard.js';
import { CrossSiteGuard, WEB_ORIGIN } from './common/guards/cross-site.guard.js';
import { CsrfGuard } from './common/guards/csrf.guard.js';
import { RateLimitGuard } from './common/guards/rate-limit.guard.js';
import { ConfigModule } from './infrastructure/config/config.module.js';
import { MailModule } from './infrastructure/mail/mail.module.js';
import { PrismaModule } from './infrastructure/prisma/prisma.module.js';
import { RedisModule } from './infrastructure/redis/redis.module.js';
import { StorageModule } from './infrastructure/storage/storage.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { ENV } from './infrastructure/tokens.js';
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
    {
      // The one browser origin, resolved once at boot from the same
      // `WEB_BASE_URL` that `configureApp` hands to `CorsMiddleware`
      // (`app-setup.ts`). One value, two readers: an allowlist and a
      // cross-site refusal that each computed their own answer is how the two
      // drift apart, and the one that drifts is always the one nobody looks at.
      provide: WEB_ORIGIN,
      inject: [ENV],
      useFactory: (env: ApiEnv): string => env.WEB_BASE_URL,
    },
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
    // have set it — so that limit is not applied to any request.
    //
    // **NOTHING REPORTS THAT, AND AN EARLIER VERSION OF THIS COMMENT SAID
    // OTHERWISE.** It claimed the guard's `unresolvedWarned` path made the gap
    // visible at runtime. It cannot: that warn is gated on
    // `unresolved.length > 0 && decisions.length > 0 && config.failMode ===
    // 'closed'` (`rate-limit.guard.ts`), and `generalSession` is
    // `failMode: 'open'` with `perPrincipal` as its ONLY scope
    // (`rate-limit.config.ts`), so `decisions.length` is 0 and the fail-mode
    // test fails as well — neither conjunct holds. The branch that does fire is
    // the every-scope-unresolvable one, which for a fail-open class logs at
    // **`debug`**, and `LOG_LEVEL` defaults to `'info'`
    // (`packages/config/src/env.ts`). At the default level this produces no log
    // output at all. Measured by the Task 7 reviewer against the real
    // `dist/main.js`: 0 lines of "not being applied", 16 of "could not be
    // resolved", all DEBUG, and only because that `.env` set `LOG_LEVEL=debug`.
    //
    // Splitting the limiter into an early per-IP stage and a late per-principal
    // stage is the real fix and is not this task's. No warn was invented here to
    // make the old sentence true: an accurate record of the gap is the fix.
    { provide: APP_GUARD, useClass: AuthenticationGuard },
    // **CSRF after authenticate**, so it runs on a request whose credential has
    // already been established, and so an unauthenticated caller gets 401
    // rather than 403 — one refusal, describing the first thing that was wrong.
    { provide: APP_GUARD, useClass: CsrfGuard },
    // **The cross-site refusal LAST**, and it is the narrowest of the four: it
    // governs only handlers carrying `@RefuseCrossSite()`, and every such
    // handler is `@Public()` — which is exactly the set `CsrfGuard` skips
    // (carry-forward ruling 56). Login CSRF has no double-submit token to
    // compare, because a cross-site login `POST` carries no session cookie for
    // one to bind to, so this is a separate mechanism rather than a widening of
    // the guard above it. Position is almost free; last is the honest place,
    // because a caller whose credential or CSRF token is wrong should hear
    // about that first.
    { provide: APP_GUARD, useClass: CrossSiteGuard },
  ],
})
export class AppModule {}
