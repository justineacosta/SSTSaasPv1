import { Module } from '@nestjs/common';
import { ConfigModule } from './infrastructure/config/config.module.js';
import { PrismaModule } from './infrastructure/prisma/prisma.module.js';
import { RedisModule } from './infrastructure/redis/redis.module.js';
import { StorageModule } from './infrastructure/storage/storage.module.js';
import { HealthModule } from './modules/health/health.module.js';

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
  imports: [ConfigModule, PrismaModule, RedisModule, StorageModule, HealthModule],
})
export class AppModule {}
