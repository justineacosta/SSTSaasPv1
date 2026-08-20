import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StorageAdapter } from '@sentinel/storage';
import {
  type DatabaseProbe,
  HealthService,
  PROBE_TIMEOUT_MS,
  type RedisProbe,
} from './health.service.js';

const okDatabase: DatabaseProbe = { $queryRaw: () => Promise.resolve([{ ok: 1 }]) };
const okRedis: RedisProbe = { ping: () => Promise.resolve('PONG') };
const okStorage = { head: () => Promise.resolve(null) } as unknown as StorageAdapter;

function serviceWith(overrides: {
  database?: DatabaseProbe;
  redis?: RedisProbe;
  storage?: StorageAdapter;
}): HealthService {
  return new HealthService(
    overrides.database ?? okDatabase,
    overrides.redis ?? okRedis,
    overrides.storage ?? okStorage,
    'evidence',
  );
}

const rejecting = (message: string): (() => Promise<never>) => {
  return () => Promise.reject(new Error(message));
};

afterEach(() => {
  vi.useRealTimers();
});

describe('HealthService.checkDependencies', () => {
  it('reports every dependency ok when every dependency answers', async () => {
    const report = await serviceWith({}).checkDependencies();
    expect(report).toEqual({
      status: 'ok',
      dependencies: { postgres: 'ok', redis: 'ok', storage: 'ok' },
    });
  });

  it.each([
    ['postgres', { database: { $queryRaw: rejecting('db down') } }],
    ['redis', { redis: { ping: rejecting('redis down') } }],
    ['storage', { storage: { head: rejecting('storage down') } as unknown as StorageAdapter }],
  ])('names %s specifically when only it is down', async (name, overrides) => {
    // An operator needs to know *which* dependency failed. A single boolean
    // sends them to look at all three. monitoring.md §5.
    const report = await serviceWith(overrides).checkDependencies();
    // Whole-object equality rather than a spot check: a probe that grew an extra
    // field would otherwise pass, and the error branch is precisely where a
    // driver's host, role, or version is tempting to attach.
    expect(report).toEqual({
      status: 'degraded',
      dependencies: {
        postgres: name === 'postgres' ? 'error' : 'ok',
        redis: name === 'redis' ? 'error' : 'ok',
        storage: name === 'storage' ? 'error' : 'ok',
      },
    });
  });

  it('checks every dependency even when the first one fails', async () => {
    const redisPing = vi.fn(() => Promise.resolve('PONG'));
    const report = await serviceWith({
      database: { $queryRaw: rejecting('db down') },
      redis: { ping: redisPing },
    }).checkDependencies();
    // Sequential short-circuiting would hide a second, worse failure behind
    // the first one every time.
    expect(redisPing).toHaveBeenCalledTimes(1);
    expect(report.dependencies.redis).toBe('ok');
  });

  it('leaks no error text, host, or credential into the report', async () => {
    const report = await serviceWith({
      database: { $queryRaw: rejecting('connect ECONNREFUSED 10.0.0.5:5432 as sentinel_app') },
      redis: { ping: rejecting('redis://user:hunter2@10.0.0.7:6379 unreachable') },
    }).checkDependencies();
    const serialised = JSON.stringify(report);
    expect(serialised).not.toContain('10.0.0.5');
    expect(serialised).not.toContain('10.0.0.7');
    expect(serialised).not.toContain('hunter2');
    expect(serialised).not.toContain('ECONNREFUSED');
    expect(serialised).not.toContain('sentinel_app');
  });

  it('gives up on a dependency that never answers rather than hanging the probe', async () => {
    vi.useFakeTimers();
    const service = serviceWith({ redis: { ping: () => new Promise<string>(() => {}) } });
    const pending = service.checkDependencies();
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS + 1);
    const report = await pending;
    // A readiness probe that hangs is indistinguishable from a wedged process,
    // and the orchestrator's own timeout is the only thing left to save it.
    expect(report.dependencies.redis).toBe('error');
    expect(report.status).toBe('degraded');
  });

  it('probes storage without listing or writing anything', async () => {
    const head = vi.fn(() => Promise.resolve(null));
    const list = vi.fn();
    const put = vi.fn();
    await serviceWith({
      storage: { head, list, put } as unknown as StorageAdapter,
    }).checkDependencies();
    expect(head).toHaveBeenCalledTimes(1);
    expect(list).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });
});

describe('HealthService.detailed', () => {
  it('adds timings and a timestamp, and nothing else', async () => {
    const report = await serviceWith({}).detailed();
    expect(Object.keys(report).sort()).toEqual(['checkedAt', 'dependencies', 'status']);
    expect(Date.parse(report.checkedAt)).not.toBeNaN();
    expect(Object.keys(report.dependencies).sort()).toEqual(['postgres', 'redis', 'storage']);
    for (const entry of Object.values(report.dependencies)) {
      expect(Object.keys(entry).sort()).toEqual(['latencyMs', 'status']);
      expect(typeof entry.latencyMs).toBe('number');
    }
  });

  it('adds timings and nothing else on the degraded path too, not only the healthy one', async () => {
    // The healthy report never executes the error branch of `probe()`, so a
    // key-shape assertion that only ever runs against an all-ok report asserts
    // nothing about the branch this endpoint exists to keep quiet. A forbidden-
    // string sweep does not close the gap either: it catches only the strings
    // someone thought of. This asserts the shape where the leak would be.
    const report = await serviceWith({
      database: { $queryRaw: rejecting('connect ECONNREFUSED db-primary.internal:5432') },
      storage: { head: rejecting('minio.internal:9000 refused') } as unknown as StorageAdapter,
    }).detailed();
    expect(report.status).toBe('degraded');
    expect(report.dependencies.postgres.status).toBe('error');
    expect(report.dependencies.storage.status).toBe('error');
    expect(Object.keys(report).sort()).toEqual(['checkedAt', 'dependencies', 'status']);
    expect(Object.keys(report.dependencies).sort()).toEqual(['postgres', 'redis', 'storage']);
    for (const entry of Object.values(report.dependencies)) {
      expect(Object.keys(entry).sort()).toEqual(['latencyMs', 'status']);
      expect(typeof entry.latencyMs).toBe('number');
    }
  });

  it('exposes no hostname, URL, version, driver, or error text', async () => {
    // monitoring.md §5 places /health/detailed behind authentication, which does
    // not exist until Phase 2. Until the guard exists, this endpoint may expose
    // nothing an unauthenticated caller could use to map the infrastructure —
    // so it is ready() plus timings, and no more.
    const report = await serviceWith({
      database: { $queryRaw: rejecting('connect ECONNREFUSED 10.0.0.5:5432') },
      storage: {
        head: rejecting('https://minio.internal:9000 refused'),
      } as unknown as StorageAdapter,
    }).detailed();
    const serialised = JSON.stringify(report);
    for (const forbidden of [
      '10.0.0.5',
      'minio',
      '9000',
      'ECONNREFUSED',
      'evidence',
      'postgresql',
    ]) {
      expect(serialised).not.toContain(forbidden);
    }
  });
});
