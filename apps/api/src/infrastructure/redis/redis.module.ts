import { Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { ApiEnv } from '@sentinel/config';
import type { Logger } from '@sentinel/observability';
import { Redis } from 'ioredis';
import { ENV, LOGGER, REDIS } from '../tokens.js';

@Injectable()
export class RedisLifecycle implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    // `quit()` rejects if the socket is already gone, which is the normal case
    // when the process is shutting down *because* Redis went away. Shutdown
    // must not itself throw.
    try {
      await this.redis.quit();
    } catch {
      this.redis.disconnect();
    }
  }
}

@Module({
  providers: [
    {
      provide: REDIS,
      inject: [ENV, LOGGER],
      useFactory: (env: ApiEnv, logger: Logger): Redis => {
        const redis = new Redis(env.REDIS_URL, {
          // The connection opens on first use rather than at construction, so
          // building the application never blocks on a dependency — which is
          // what lets `/health/live` answer while Redis is down.
          lazyConnect: true,
          connectTimeout: 2_000,
          // A readiness probe wants a fast, honest failure, not a command that
          // sits in the retry queue until the probe itself times out. One retry,
          // then report unavailable; `retryStrategy` keeps reconnecting in the
          // background so the service recovers without an operator.
          maxRetriesPerRequest: 1,
          retryStrategy: (attempt) => Math.min(attempt * 200, 2_000),
        });

        // ioredis emits `error` on an EventEmitter. Node terminates the process
        // for an `error` event with no listener, so an unreachable Redis would
        // take down an API that is otherwise perfectly able to serve — the
        // opposite of what the liveness/readiness split exists to achieve.
        // The error object goes through the logger's redacting `err`
        // serialiser, which matters because ioredis puts the connection URL,
        // credentials and all, into its own error text.
        redis.on('error', (error: unknown) => {
          logger.warn({ err: error }, 'Redis connection error');
        });

        return redis;
      },
    },
    RedisLifecycle,
  ],
  exports: [REDIS],
})
export class RedisModule {}
