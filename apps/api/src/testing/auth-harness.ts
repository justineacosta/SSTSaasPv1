import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { type PostgresHarness, startPostgresHarness } from '@sentinel/db/testing';
import { createUnscopedPrismaClient, type PrismaClient } from '@sentinel/db/unscoped';
import { config as loadDotenv } from 'dotenv';
import { AppModule } from '../app.module.js';
import { configureApp } from '../app-setup.js';
import { MAILER, PRISMA, REDIS } from '../infrastructure/tokens.js';
import type { Mailer, OutgoingMail, SentMail } from '../infrastructure/mail/mailer.port.js';

/**
 * The real application, wired to a Testcontainers Postgres and a recording
 * mailer, shared by the two Task 8 integration specs.
 *
 * **Postgres comes from the harness, Redis from compose.** Task 6 recorded why
 * and Task 7's specs follow it: CI never applies migrations to the compose
 * database, so a spec inserting into `User` against it passes locally and fails
 * in CI with "relation does not exist".
 *
 * **The mailer is a recorder rather than Mailpit.** These specs assert what was
 * sent and to whom, and reading that back out of Mailpit's HTTP API would make
 * every assertion depend on a fourth service and on delivery timing. The
 * adapter itself is covered by `smtp-mailer.integration.spec.ts` against the
 * real Mailpit; what is under test here is which template the endpoint chose.
 *
 * Not a `.spec.ts` file: it holds no tests, so `pnpm check:specs` has nothing
 * to claim. It lives in `src/testing/` rather than beside the specs that use
 * it because that directory is where `eslint.config.js` grants the harness
 * exemption for `@sentinel/db/testing`, the unscoped client and `process.env`
 * — the alternative was widening a security fence for one file, which is a
 * worse trade than a directory move.
 */

loadDotenv({ path: fileURLToPath(new URL('../../../../.env', import.meta.url)) });

export interface RedisLike {
  del(...keys: string[]): Promise<number>;
  scan(
    cursor: string,
    match: 'MATCH',
    pattern: string,
    count: 'COUNT',
    countValue: number,
  ): Promise<[string, string[]]>;
}

export interface AuthHarness {
  readonly app: NestExpressApplication;
  readonly server: Server;
  readonly prisma: PrismaClient;
  readonly postgres: PostgresHarness;
  readonly redis: RedisLike;
  readonly sent: OutgoingMail[];
  stop(): Promise<void>;
}

export async function startAuthHarness(): Promise<AuthHarness> {
  process.env.NODE_ENV = 'test';
  process.env.APP_ENV = 'test';

  const postgres = await startPostgresHarness();
  const prisma = createUnscopedPrismaClient(postgres.ownerUrl);
  const sent: OutgoingMail[] = [];
  const recordingMailer: Mailer = {
    send: (mail): Promise<SentMail> => {
      sent.push(mail);
      return Promise.resolve({ messageId: `harness-${String(sent.length)}` });
    },
  };

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PRISMA)
    .useValue(prisma)
    .overrideProvider(MAILER)
    .useValue(recordingMailer)
    .compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>();
  configureApp(app);
  await app.init();

  const redis = app.get<RedisLike>(REDIS);

  return {
    app,
    server: app.getHttpServer(),
    prisma,
    postgres,
    redis,
    sent,
    stop: async () => {
      await app.close();
      await prisma.$disconnect();
      await postgres.stop();
    },
  };
}

/**
 * The rate-limit classes Task 8's routes carry. Their buckets are keyed on the
 * loopback address every request in these suites arrives from, so without this
 * the second test in a file is refused by the first test's window —
 * `registration` allows three an hour.
 *
 * Scanned by class prefix rather than `FLUSHDB`: carry-forward ruling 33, the
 * compose Redis is shared with every other integration suite and with a
 * developer's running application.
 */
export const TASK_8_RATE_LIMIT_CLASSES = [
  'registration',
  'emailVerificationConsume',
  'emailVerificationResend',
] as const;

export async function clearRateLimits(redis: RedisLike): Promise<void> {
  for (const className of TASK_8_RATE_LIMIT_CLASSES) {
    let cursor = '0';
    do {
      const [next, found] = await redis.scan(
        cursor,
        'MATCH',
        `ratelimit:${className}:*`,
        'COUNT',
        500,
      );
      if (found.length > 0) await redis.del(...found);
      cursor = next;
    } while (cursor !== '0');
  }
}

/**
 * Pulls the `?token=` value out of a rendered message.
 *
 * The text part, not the HTML: it is the part a plain-text client sees, and a
 * link that exists only in the markup is a link half the recipients cannot use.
 * Carry-forward ruling 41 fixes the parameter name, so this is also an
 * assertion about the link shape by construction — a token moved into a path
 * segment would make this return undefined and every caller fail.
 */
export function tokenFromMail(mail: OutgoingMail | undefined): string {
  const match = /https?:\/\/\S+/.exec(mail?.text ?? '');
  if (match === null) throw new Error('no link in the message');
  const token = new URL(match[0]).searchParams.get('token');
  if (token === null) throw new Error('no ?token= in the link');
  return token;
}
