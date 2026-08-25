import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import type { ApiEnv } from '@sentinel/config';
import { createLogger, type Logger } from '@sentinel/observability';
import { ENV, LOGGER } from '../../infrastructure/tokens.js';
import { AuthModule } from './auth.module.js';
import { BreachCheckService } from './breach-check.service.js';
import { PasswordService } from './password.service.js';

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
} as unknown as ApiEnv;

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

describe('AuthModule', () => {
  it('resolves both services from configuration', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [StubConfigModule, AuthModule],
    }).compile();

    expect(moduleRef.get(PasswordService)).toBeInstanceOf(PasswordService);
    expect(moduleRef.get(BreachCheckService)).toBeInstanceOf(BreachCheckService);
    await moduleRef.close();
  });

  it('registers no controller', () => {
    // Ruling 1, and the reason `pnpm check:openapi` still reports four routes.
    // A route shipped here would be unauthenticated and unguarded until Task 7.
    const controllers = Reflect.getMetadata('controllers', AuthModule) as unknown;
    expect(controllers ?? []).toEqual([]);
  });

  it('builds a password service that actually hashes at the configured parameters', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [StubConfigModule, AuthModule],
    }).compile();

    const service = moduleRef.get(PasswordService);
    const phc = await service.hash('correct horse battery staple');
    expect(phc.startsWith('$argon2id$v=19$m=1024,t=1,p=1$')).toBe(true);
    await moduleRef.close();
  });

  it('builds a breach check that is off, so it never reaches the network', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [StubConfigModule, AuthModule],
    }).compile();

    // The default is false (ADR-0015). If this ever resolved to true, the
    // provider below would call the real `fetch` transport from a unit test.
    expect(await moduleRef.get(BreachCheckService).isBreached('any password')).toBe(false);
    await moduleRef.close();
  });
});
