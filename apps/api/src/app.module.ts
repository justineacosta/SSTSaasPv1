import { Module } from '@nestjs/common';
import { APP_GUARD, DiscoveryModule } from '@nestjs/core';
import { RateLimitGuard } from './common/guards/rate-limit.guard.js';
import { ConfigModule } from './infrastructure/config/config.module.js';
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
  ],
})
export class AppModule {}
