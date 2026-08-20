import { Module, type MiddlewareConsumer, type NestModule, RequestMethod } from '@nestjs/common';
import { ConfigModule } from './infrastructure/config/config.module.js';
import { PrismaModule } from './infrastructure/prisma/prisma.module.js';
import { RedisModule } from './infrastructure/redis/redis.module.js';
import { StorageModule } from './infrastructure/storage/storage.module.js';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware.js';
import { SecurityHeadersMiddleware } from './common/middleware/security-headers.middleware.js';
import { HealthModule } from './modules/health/health.module.js';

/**
 * The composition root.
 *
 * Middleware order is the first two rows of architecture/backend.md §3 and is
 * asserted by `app.integration.spec.ts`: the request ID is established before
 * anything else so that every later stage — including a failure inside the
 * security-headers middleware itself — has something to correlate by. Security
 * headers come next so they are present on a response even when a later stage
 * throws.
 */
@Module({
  imports: [ConfigModule, PrismaModule, RedisModule, StorageModule, HealthModule],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(RequestIdMiddleware, SecurityHeadersMiddleware)
      .forRoutes({ path: '*splat', method: RequestMethod.ALL });
  }
}
