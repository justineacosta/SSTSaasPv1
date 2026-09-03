import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import type { Type } from '@nestjs/common';
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
  /**
   * Reads one key. Added in Task 9 so a spec can assert that a logout left a
   * **tombstone** rather than merely deleting the entry — the two are
   * indistinguishable from the outside (both make the next resolve miss) and
   * only the tombstone survives a concurrent live write, which is the property
   * `session.cache.ts`'s Lua compare-and-set exists for.
   */
  get(key: string): Promise<string | null>;
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
  /**
   * The schema-owner client the specs set fixtures up with.
   *
   * **It is a superuser and therefore bypasses row-level security**, which is
   * exactly why it is the right tool for seeding and the wrong one for
   * asserting that a production read works. See `appPrisma`.
   */
  readonly prisma: PrismaClient;
  /**
   * A second client bound to `sentinel_app` — the least-privileged role the API
   * process itself connects as, and the one every RLS policy applies to.
   *
   * It exists because of a measured trap. `Organization` carries
   * `FORCE ROW LEVEL SECURITY` keyed on `id`, so a read without
   * `app.organization_id` set returns **zero rows** for that role while
   * returning the row for the owner. A spec that seeded and asserted through
   * `prisma` alone would prove nothing about production and would go green over
   * a lookup that always answers `null` there — carry-forward ruling 58's shape
   * exactly: every fixture on one side of the branch under test.
   */
  readonly appPrisma: PrismaClient;
  readonly postgres: PostgresHarness;
  readonly redis: RedisLike;
  readonly sent: OutgoingMail[];
  stop(): Promise<void>;
}

export interface AuthHarnessOptions {
  /**
   * WHICH POSTGRES ROLE THE APPLICATION UNDER TEST CONNECTS AS.
   *
   * `'owner'` (the default, and what every suite before Task 12 uses) binds
   * `PRISMA` to the schema owner. That role is a superuser and **bypasses
   * row-level security**, which is carry-forward ruling 75: a spec that
   * replaced `withTenantTransaction(...)` with a direct client call left both
   * lanes green, because the whole application under integration test was
   * connecting as the container superuser and no policy could bite.
   *
   * `'app'` binds it to `sentinel_app` — the least-privileged role the API
   * process actually connects as in production, and the one every RLS policy
   * applies to. **A spec asserting a property that only RLS provides must use
   * it**, or it is asserting that Postgres has policies rather than that this
   * code obeys them.
   *
   * The default is `'owner'` rather than the safer value on purpose: switching
   * every existing suite to `'app'` in this task would change what a dozen
   * specs are testing in a change nobody reviewed for that. New suites choose
   * deliberately; `authorization.integration.spec.ts` chooses `'app'` and says
   * why.
   *
   * `harness.prisma` is the owner client either way, because fixtures have to
   * be seeded by a role that can write them.
   */
  readonly connectAs?: 'owner' | 'app';
  /**
   * Extra controllers compiled into the **real** `AppModule`.
   *
   * For proving a guard on arms no shipped route exercises. Task 12's
   * authorization guard is the case it exists for: no endpoint declared
   * `@RequirePermission()` before Task 13, so the only way to run the real
   * guard array, in the real order, against real rows was to add a route that
   * did. Task 13 shipped three such endpoints, and this option remains the way
   * to reach role and permission combinations they do not express.
   * Everything except the endpoint stays production.
   *
   * `buildGuardedApp` in `routing-app.ts` is the unit-lane equivalent and
   * assembles a *minimal* application; this one assembles the whole graph, so a
   * guard that depends on a provider nobody registered fails here rather than
   * being stubbed past.
   */
  readonly controllers?: readonly Type[];
}

export async function startAuthHarness(options: AuthHarnessOptions = {}): Promise<AuthHarness> {
  process.env.NODE_ENV = 'test';
  process.env.APP_ENV = 'test';

  const postgres = await startPostgresHarness();
  const prisma = createUnscopedPrismaClient(postgres.ownerUrl);
  const appPrisma = createUnscopedPrismaClient(postgres.appUrl);
  const sent: OutgoingMail[] = [];
  const recordingMailer: Mailer = {
    send: (mail): Promise<SentMail> => {
      sent.push(mail);
      return Promise.resolve({ messageId: `harness-${String(sent.length)}` });
    },
  };

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
    controllers: [...(options.controllers ?? [])],
  })
    .overrideProvider(PRISMA)
    .useValue(options.connectAs === 'app' ? appPrisma : prisma)
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
    appPrisma,
    postgres,
    redis,
    sent,
    stop: async () => {
      await app.close();
      await prisma.$disconnect();
      await appPrisma.$disconnect();
      await postgres.stop();
    },
  };
}

/**
 * The rate-limit classes the shipped auth routes carry. Their buckets are keyed
 * on the loopback address every request in these suites arrives from, so
 * without this the second test in a file is refused by the first test's window
 * — `registration` allows three an hour, and `login` five per account per
 * fifteen minutes.
 *
 * Scanned by class prefix rather than `FLUSHDB`: carry-forward ruling 33, the
 * compose Redis is shared with every other integration suite and with a
 * developer's running application.
 *
 * `generalSession` is in the list although `logout` and `session` carry it and
 * it resolves nothing today (carry-forward ruling 55) — so it writes no keys
 * and the scan finds none. It is listed so that the day the limiter is split
 * into an early per-IP stage and it starts resolving, these suites do not begin
 * failing on a window nobody remembered to clear.
 */
export const AUTH_RATE_LIMIT_CLASSES = [
  'registration',
  'emailVerificationConsume',
  'emailVerificationResend',
  'login',
  'generalSession',
  // Task 10's three routes. `passwordReset` keys per address AND per IP, so a
  // suite that registers many addresses from loopback exhausts the per-IP half
  // (10/hour) long before it finishes; `passwordResetConsume` is 20/hour and
  // `passwordChange` 10/hour, both per IP only, which one describe block can
  // spend on its own.
  'passwordReset',
  'passwordResetConsume',
  'passwordChange',
  // Task 11's two. `mfaVerify` is 60/hour per IP and `mfaManagement` 10/hour,
  // both per IP only, and every request in `auth.mfa.integration.spec.ts`
  // arrives from loopback — one `describe` block exhausts `mfaManagement`
  // several times over without this.
  'mfaVerify',
  'mfaManagement',
  // Task 15's invite route. 50/day PER ORGANISATION and fail-closed, and it is
  // the first class in this codebase whose limit actually applies to a shipped
  // route — `perOrganization` had no resolvable identifier until the limiter
  // gained its tenant-phase pass. Every test in
  // `invitations.integration.spec.ts` creates a fresh organisation, so the
  // windows do not overlap between tests; this entry is here so a suite that
  // deliberately spends one organisation's budget can hand the next test a
  // clean one, and so the lane does not carry a day-long window between runs
  // on a developer's compose Redis.
  'invitations',
] as const;

export async function clearRateLimits(redis: RedisLike): Promise<void> {
  for (const className of AUTH_RATE_LIMIT_CLASSES) {
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
