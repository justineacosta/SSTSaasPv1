import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import type { ApiEnv } from '@sentinel/config';
import { createLogger, type Logger } from '@sentinel/observability';
import { ENV, LOGGER, PRISMA, REDIS } from '../../infrastructure/tokens.js';
import { AuthModule } from './auth.module.js';
import { BreachCheckService } from './breach-check.service.js';
import { PasswordService } from './password.service.js';
import { SessionService } from './session.service.js';
import { TokenService, type VerificationTokenStore } from './token.service.js';

/**
 * The env fields `AuthModule` reads, and nothing else.
 *
 * Reduced Argon2 parameters, because this spec is about wiring and the cost
 * buys no additional assurance. The real cost of the configured defaults,
 * measured 2026-08-25 on the development machine (Windows 11 x64, Node
 * v26.7.0, 12 logical CPUs): **37.4 ms** for the one `hashSync` a module build
 * performs. ~250ms is the tuning target in `security/authentication.md` §2,
 * which ADR-0014 records as untuned — it is not an observed cost, and an
 * earlier version of this comment asserted it as one (review 3c5d694, F3).
 */
const env = {
  PASSWORD_ARGON2_MEMORY_KIB: 1024,
  PASSWORD_ARGON2_TIME_COST: 1,
  PASSWORD_ARGON2_PARALLELISM: 1,
  PASSWORD_BREACH_CHECK_ENABLED: false,
  PASSWORD_BREACH_CHECK_RANGE_URL: 'https://api.pwnedpasswords.com/range',
  PASSWORD_BREACH_CHECK_TIMEOUT_MS: 2_000,
  TOKEN_TTL_EMAIL_VERIFICATION_SECONDS: 86_400,
  TOKEN_TTL_PASSWORD_RESET_SECONDS: 3_600,
  TOKEN_TTL_INVITATION_SECONDS: 604_800,
  SESSION_ABSOLUTE_LIFETIME_SECONDS: 604_800,
  SESSION_REMEMBER_ME_LIFETIME_SECONDS: 2_592_000,
  SESSION_IDLE_TIMEOUT_SECONDS: 86_400,
  SESSION_PENDING_MFA_LIFETIME_SECONDS: 600,
  SESSION_CACHE_TTL_SECONDS: 60,
  REDIS_URL: 'redis://127.0.0.1:6399',
} as unknown as ApiEnv;

/**
 * Stands in for the real `PRISMA` provider.
 *
 * Overridden rather than imported for real: `PrismaModule`'s factory builds a
 * live client from `env.DATABASE_URL`, and a wiring spec has no business
 * opening a connection pool. The override is what proves `AuthModule` asks for
 * `PRISMA` by that token at all — remove `imports: [PrismaModule]` and the
 * module fails to compile with an unresolved dependency instead of quietly
 * resolving to nothing.
 */
const verificationToken = {
  create: () => Promise.resolve({}),
  updateMany: () => Promise.resolve({ count: 0 }),
  findUnique: () => Promise.resolve(null),
};

const prismaStub: VerificationTokenStore & {
  // PrismaModule also registers PrismaLifecycle, whose shutdown hook runs on
  // moduleRef.close(). Measured: without these two the spec fails with
  // "this.prisma.$disconnect is not a function".
  $connect: () => Promise<void>;
  $disconnect: () => Promise<void>;
} = {
  $connect: () => Promise.resolve(),
  $disconnect: () => Promise.resolve(),
  verificationToken,
  // `$queryRaw` is the advisory lock `issue` takes before superseding. This
  // spec only proves the module wires up and resolves, so the stub returns an
  // empty result set rather than pretending to lock anything — the lock's real
  // behaviour is asserted in token.service.spec.ts (that it is issued, first,
  // and on the right key) and in the integration spec's ten-round race (that it
  // works).
  $transaction: (run) => run({ verificationToken, $queryRaw: () => Promise.resolve([]) }),
};

/**
 * Stands in for the real `REDIS` provider, for `PrismaModule`'s reason.
 *
 * `RedisModule`'s factory builds a live ioredis client, and a wiring spec has
 * no business opening a socket. Overriding it is also what proves `AuthModule`
 * asks for `REDIS` at all — drop `RedisModule` from its imports and the module
 * fails to compile with an unresolved dependency rather than quietly resolving
 * to nothing.
 */
const redisStub = {
  get: () => Promise.resolve(null),
  set: () => Promise.resolve('OK'),
  eval: () => Promise.resolve(1),
  quit: () => Promise.resolve('OK'),
  disconnect: () => undefined,
};

/** Stands in for the application's global `ConfigModule`. */
@Global()
@Module({
  providers: [
    { provide: ENV, useValue: env },
    {
      provide: LOGGER,
      useFactory: (): Logger =>
        createLogger({ service: 'test', level: 'warn', pretty: false, silent: true }),
    },
  ],
  exports: [ENV, LOGGER],
})
class StubConfigModule {}

function buildModule() {
  return Test.createTestingModule({ imports: [StubConfigModule, AuthModule] })
    .overrideProvider(PRISMA)
    .useValue(prismaStub)
    .overrideProvider(REDIS)
    .useValue(redisStub)
    .compile();
}

describe('AuthModule', () => {
  it('resolves all four services from configuration', async () => {
    const moduleRef = await buildModule();

    expect(moduleRef.get(PasswordService)).toBeInstanceOf(PasswordService);
    expect(moduleRef.get(BreachCheckService)).toBeInstanceOf(BreachCheckService);
    expect(moduleRef.get(TokenService)).toBeInstanceOf(TokenService);
    expect(moduleRef.get(SessionService)).toBeInstanceOf(SessionService);
    await moduleRef.close();
  });

  it('does not export the session repository', async () => {
    // `SessionRepository` is `SessionService`'s Postgres access. A consumer
    // holding it could revoke a row without poisoning the cache entry that
    // would go on serving it, which is the one thing the whole cache design
    // exists to prevent.
    const moduleRef = await buildModule();
    const exported = Reflect.getMetadata('exports', AuthModule) as unknown[];
    expect(exported.map((entry) => (entry as { name?: string }).name ?? entry)).not.toContain(
      'SessionRepository',
    );
    await moduleRef.close();
  });

  it('builds a token service carrying authentication.md §6 TTLs for all three kinds', async () => {
    const moduleRef = await buildModule();

    const service = moduleRef.get(TokenService);
    expect(service.ttlSecondsFor('EMAIL_VERIFICATION')).toBe(86_400);
    expect(service.ttlSecondsFor('PASSWORD_RESET')).toBe(3_600);
    // Ruling 8: nothing in this task reads the invitation TTL, so this
    // assertion is what keeps it from becoming a variable nobody can reach.
    expect(service.ttlSecondsFor('INVITATION')).toBe(604_800);
    await moduleRef.close();
  });

  it('registers no controller', () => {
    // Ruling 1, and the reason `pnpm check:openapi` still reports four routes.
    // A route shipped here would be unauthenticated and unguarded until Task 7.
    const controllers = Reflect.getMetadata('controllers', AuthModule) as unknown;
    expect(controllers ?? []).toEqual([]);
  });

  it('builds a password service that actually hashes at the configured parameters', async () => {
    const moduleRef = await buildModule();

    const service = moduleRef.get(PasswordService);
    const phc = await service.hash('correct horse battery staple');
    expect(phc.startsWith('$argon2id$v=19$m=1024,t=1,p=1$')).toBe(true);
    await moduleRef.close();
  });

  it('builds a breach check that is off, so it never reaches the network', async () => {
    const moduleRef = await buildModule();

    // The default is false (ADR-0015). If this ever resolved to true, the
    // provider below would call the real `fetch` transport from a unit test.
    expect(await moduleRef.get(BreachCheckService).isBreached('any password')).toBe(false);
    await moduleRef.close();
  });
});
