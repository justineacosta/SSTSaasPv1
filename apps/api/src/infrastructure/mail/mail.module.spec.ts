import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { ApiEnv } from '@sentinel/config';
import { createLogger, type Logger } from '@sentinel/observability';
import { ENV, LOGGER, MAILER } from '../tokens.js';
import type { Mailer } from './mailer.port.js';
import { MailModule } from './mail.module.js';

/**
 * The module boots with the mail server down, and that is the point of it.
 *
 * Ruling 49: mail is not on the liveness path. `transporter.verify()` in a
 * constructor or an `onModuleInit` turns an SMTP outage into an API outage —
 * every instance crash-looping over a dependency that serves none of the
 * product's requests — when `/health/live` and `/health/ready` already exist to
 * report degradation without refusing to start. `PrismaLifecycle` records the
 * same reasoning for a database that is down.
 *
 * `smtp-mailer.spec.ts` asserts the adapter never calls `verify()`; this
 * asserts the wired module reaches the network at no point during boot, by
 * pointing it at a port nothing is listening on and requiring the application
 * to come up anyway.
 */
const env = {
  MAIL_HOST: '127.0.0.1',
  // Port 1 is privileged, unbound, and deliberately not the compose Mailpit on
  // 1025 — a connection attempt here fails rather than quietly succeeding and
  // leaving this spec proving nothing.
  MAIL_PORT: 1,
  MAIL_FROM: 'Sentinel <no-reply@sentinel.local>',
  MAIL_SECURE: false,
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

function buildModule() {
  return Test.createTestingModule({ imports: [StubConfigModule, MailModule] }).compile();
}

describe('MailModule', () => {
  it('resolves MAILER from configuration', async () => {
    const moduleRef = await buildModule();
    const mailer = moduleRef.get<Mailer>(MAILER);
    expect(typeof mailer.send).toBe('function');
    await moduleRef.close();
  });

  it('initialises with an unreachable relay instead of refusing to start', async () => {
    const moduleRef = await buildModule();
    await expect(moduleRef.init()).resolves.toBeDefined();
    await moduleRef.close();
  });

  it('registers no controller, so it can ship no route', async () => {
    // Task 5 builds no endpoint. `pnpm check:openapi` is what holds that across
    // the whole application; this holds it for the module itself, which is
    // where a controller would be added by someone who did not read the brief.
    expect(Reflect.getMetadata('controllers', MailModule)).toBeUndefined();
    const moduleRef = await buildModule();
    await moduleRef.close();
  });
});
