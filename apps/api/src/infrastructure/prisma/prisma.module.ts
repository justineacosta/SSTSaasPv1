import {
  Inject,
  Injectable,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { ApiEnv } from '@sentinel/config';
// The unscoped client, imported here and nowhere else in apps/api. See the
// class docblock below and the matching directory exemption in
// eslint.config.js.
import { createUnscopedPrismaClient, type PrismaClient } from '@sentinel/db/unscoped';
import { ENV, PRISMA } from '../tokens.js';

/**
 * Owns the process-wide database connection pool.
 *
 * This is the one module in `apps/api` permitted to import the unscoped client,
 * and it exports it under a token that only infrastructure consumes.
 * `createTenantClient` wraps this base client per request, which is the client
 * handlers actually receive — see security/tenant-isolation.md §2 and ADR-0006.
 * Handing this token to a controller or a repository is the defect the lint
 * rule exists to catch; the exemption is scoped to this file alone.
 */
@Injectable()
export class PrismaLifecycle implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  /**
   * Opens the pool before the process starts serving.
   *
   * Prisma connects lazily, and its *first* query pays for spawning the query
   * engine — measured at 2.1s cold against the local compose stack, which is
   * longer than the readiness probe's own timeout. Left lazy, the first
   * `/health/ready` after every deploy would report Postgres down and the
   * rollout would stall on a database that was fine.
   *
   * A failure here is swallowed on purpose: the service must still start when
   * the database is down, so that `/health/live` answers (the process is fine)
   * while `/health/ready` reports which dependency is not. Crashing here would
   * turn a database outage into a crash-loop across every instance, which is
   * the same failure mode monitoring.md §5 gives for liveness probes that check
   * dependencies.
   */
  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.prisma.$connect();
    } catch {
      // Intentionally ignored. `/health/ready` is what reports this.
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.prisma.$disconnect();
  }
}

@Module({
  providers: [
    {
      provide: PRISMA,
      inject: [ENV],
      useFactory: (env: ApiEnv): PrismaClient => createUnscopedPrismaClient(env.DATABASE_URL),
    },
    PrismaLifecycle,
  ],
  exports: [PRISMA],
})
export class PrismaModule {}
