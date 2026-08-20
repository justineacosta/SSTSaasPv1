import { Inject, Injectable } from '@nestjs/common';
import type { StorageAdapter } from '@sentinel/storage';
import { EVIDENCE_BUCKET, PRISMA, REDIS, STORAGE } from '../../infrastructure/tokens.js';

/** The slice of Prisma this service uses. A test supplies a stub instead. */
export interface DatabaseProbe {
  $queryRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
}

/** The slice of ioredis this service uses. */
export interface RedisProbe {
  ping(): Promise<string>;
}

export const DEPENDENCY_NAMES = ['postgres', 'redis', 'storage'] as const;
export type DependencyName = (typeof DEPENDENCY_NAMES)[number];

export type DependencyStatus = 'ok' | 'error';

export interface ReadinessReport {
  readonly status: 'ok' | 'degraded';
  readonly dependencies: Record<DependencyName, DependencyStatus>;
}

export interface DetailedReport {
  readonly status: 'ok' | 'degraded';
  readonly checkedAt: string;
  readonly dependencies: Record<DependencyName, { status: DependencyStatus; latencyMs: number }>;
}

/**
 * A readiness probe answers within the orchestrator's timeout or it is
 * indistinguishable from a wedged process. Two seconds is well inside a typical
 * one-second-interval, three-failure readiness gate and well outside any healthy
 * round trip to a container on the same network.
 */
export const PROBE_TIMEOUT_MS = 2_000;

/**
 * The key `head()` is called against. Absent by construction — it lives outside
 * every tenant prefix (`packages/storage/src/keys.ts`), so it can never collide
 * with real evidence and can never be created by ordinary operation.
 */
const PROBE_KEY = '_healthcheck/probe';

async function withTimeout<T>(operation: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error('Dependency probe timed out.'));
        }, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

interface ProbeResult {
  readonly status: DependencyStatus;
  readonly latencyMs: number;
}

async function probe(run: () => Promise<unknown>): Promise<ProbeResult> {
  const startedAt = process.hrtime.bigint();
  try {
    await withTimeout(run(), PROBE_TIMEOUT_MS);
    return { status: 'ok', latencyMs: elapsedMs(startedAt) };
  } catch {
    // The caught error is deliberately dropped rather than reported. A driver
    // error message is where the connection string, the internal host, the
    // database role, and occasionally the password live — and these endpoints
    // answer an unauthenticated caller. api/errors.md §5.
    return { status: 'error', latencyMs: elapsedMs(startedAt) };
  }
}

function elapsedMs(startedAt: bigint): number {
  return Math.round(Number(process.hrtime.bigint() - startedAt) / 1e5) / 10;
}

/**
 * Runs the dependency probes behind `/health/ready` and `/health/detailed`.
 *
 * Every probe runs concurrently and every result is reported, so one failure
 * never hides another — sequential short-circuiting would report "postgres is
 * down" during an outage that had taken out all three, and the operator would
 * fix one thing and wonder why nothing recovered.
 *
 * Nothing about *why* a dependency failed leaves this class. Which dependency
 * is enough to route an operator to the right runbook; the reason is in the
 * server log, which the request ID correlates to.
 */
@Injectable()
export class HealthService {
  constructor(
    @Inject(PRISMA) private readonly database: DatabaseProbe,
    @Inject(REDIS) private readonly redis: RedisProbe,
    @Inject(STORAGE) private readonly storage: StorageAdapter,
    @Inject(EVIDENCE_BUCKET) private readonly evidenceBucket: string,
  ) {}

  private async runProbes(): Promise<Record<DependencyName, ProbeResult>> {
    const [postgres, redis, storage] = await Promise.all([
      probe(() => this.database.$queryRaw`SELECT 1`),
      probe(() => this.redis.ping()),
      // A HEAD on a key that does not exist. It proves the endpoint is
      // reachable and the credential is accepted (a rejected credential is a
      // 403, which the adapter rethrows rather than reporting as "absent"),
      // without listing or writing anything.
      //
      // LIMITATION: S3 answers HEAD on a missing *bucket* with the same 404 as
      // a missing key, so this probe cannot tell those apart. Bucket existence
      // is a deploy-time invariant rather than something that flaps at runtime,
      // and the alternative — a prefixed `list()` — needs `s3:ListBucket`,
      // which the production evidence credential is not guaranteed to hold.
      probe(() => this.storage.head(this.evidenceBucket, PROBE_KEY)),
    ]);
    return { postgres, redis, storage };
  }

  async checkDependencies(): Promise<ReadinessReport> {
    const results = await this.runProbes();
    return {
      status: Object.values(results).every((result) => result.status === 'ok') ? 'ok' : 'degraded',
      dependencies: {
        postgres: results.postgres.status,
        redis: results.redis.status,
        storage: results.storage.status,
      },
    };
  }

  async detailed(): Promise<DetailedReport> {
    const results = await this.runProbes();
    return {
      status: Object.values(results).every((result) => result.status === 'ok') ? 'ok' : 'degraded',
      checkedAt: new Date().toISOString(),
      dependencies: results,
    };
  }
}
