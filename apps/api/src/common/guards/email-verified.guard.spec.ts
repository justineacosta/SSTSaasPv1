import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { globSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Controller,
  Get,
  type CanActivate,
  type ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { AppModule } from '../../app.module.js';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { errorEnvelopeSchema } from '@sentinel/contracts';
import type { Request } from 'express';
import request from 'supertest';
import { PRISMA } from '../../infrastructure/tokens.js';
import { buildGuardedApp } from '../../testing/routing-app.js';
import { AuthenticatedOnly, Public } from '../decorators/access.decorator.js';
import { RequireVerifiedEmail } from '../decorators/email-verified.decorator.js';
import { EmailVerifiedGuard, type VerifiedEmailLookup } from './email-verified.guard.js';

/**
 * THE GATE, PROVED AGAINST PURPOSE-BUILT CONTROLLERS BECAUSE THERE IS NO REAL
 * ROUTE TO PROVE IT AGAINST.
 *
 * Ruling F. Task 8's three routes are all `@Public()` and all reachable by
 * someone with no account, so nothing in the product can carry
 * `@RequireVerifiedEmail()` yet: `GET /auth/session` is Task 9's and
 * organisation creation is Task 13's. The controllers below exist nowhere in
 * the application, which is the same thing `routing-app.ts` was built for in
 * Task 7 and the same precedent `@AllowPendingMfa()` set.
 *
 * **The last test in this file is what stops the rest of it being vacuous.**
 * Carry-forward ruling 58: a suite whose fixtures all sit on one side of the
 * branch under test cannot fail for the right reason, which is exactly how
 * Task 7's CSRF suite missed a hole. So there is an ungated route here as well,
 * and it must be reachable by an unverified user — if the guard started
 * refusing everything, that test goes red rather than the suite going greener.
 */

const VERIFIED_USER = 'usr_01M0T74WZZFY9T2QS56RGF3GQ7';
const UNVERIFIED_USER = 'usr_01M0T74WZZFY9T2QS56RGF3GQ8';
const VANISHED_USER = 'usr_01M0T74WZZFY9T2QS56RGF3GQ9';

const lookup: VerifiedEmailLookup = {
  user: {
    findUnique: ({ where }) => {
      if (where.id === VERIFIED_USER) {
        return Promise.resolve({
          emailVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
          status: 'ACTIVE',
        });
      }
      if (where.id === UNVERIFIED_USER) {
        return Promise.resolve({ emailVerifiedAt: null, status: 'ACTIVE' });
      }
      return Promise.resolve(null);
    },
  },
};

/**
 * Stands in for `AuthenticationGuard`, which is not registered here for the
 * same reason the CSRF spec omits it: mixing the two makes every failure
 * ambiguous between 401 and 403. The user id comes from a header so one
 * application can serve every case.
 */
@Injectable()
class FakePrincipalGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const httpRequest = context.switchToHttp().getRequest<Request>();
    const userId = httpRequest.headers['x-test-user'];
    if (typeof userId === 'string' && userId !== '') {
      httpRequest.principal = { kind: 'user', userId, sessionId: 'ses_test' };
    }
    return true;
  }
}

/** The gate declared on one handler. */
@Controller('handler')
class HandlerGatedController {
  @AuthenticatedOnly()
  @RequireVerifiedEmail()
  @Get('gated')
  gated(): string {
    return 'ok';
  }

  @AuthenticatedOnly()
  @Get('open')
  open(): string {
    return 'ok';
  }
}

/**
 * The gate declared on the CLASS. Carry-forward ruling 61: an exemption must be
 * handler-only and tested at the class level to prove it; a REQUIREMENT is the
 * opposite — a class-level declaration must actually apply, and this is where
 * that is checked rather than assumed.
 */
@RequireVerifiedEmail()
@Controller('klass')
class ClassGatedController {
  @AuthenticatedOnly()
  @Get('gated')
  gated(): string {
    return 'ok';
  }
}

@RequireVerifiedEmail()
class GatedBaseController {}

/**
 * The inheritance case. `getAllAndOverride` walks the prototype chain, so a
 * controller extending an annotated base inherits the requirement — a fact
 * worth an assertion, because a future guard rewritten to `reflector.get`
 * against `getClass()` alone would silently stop covering it.
 */
@Controller('inherited')
class InheritedGatedController extends GatedBaseController {
  @AuthenticatedOnly()
  @Get('gated')
  gated(): string {
    return 'ok';
  }
}

/** A route with no gate at all, so the suite has fixtures on both sides. */
@Controller('ungated')
class UngatedController {
  @Public()
  @Get()
  read(): string {
    return 'ok';
  }
}

let app: NestExpressApplication;
let server: Server;

beforeAll(async () => {
  app = await buildGuardedApp({
    controllers: [
      HandlerGatedController,
      ClassGatedController,
      InheritedGatedController,
      UngatedController,
    ],
    providers: [
      Reflector,
      { provide: PRISMA, useValue: lookup },
      { provide: APP_GUARD, useClass: FakePrincipalGuard },
      { provide: APP_GUARD, useClass: EmailVerifiedGuard },
    ],
  });
  server = app.getHttpServer();
});

afterAll(async () => {
  await app.close();
});

const asUser = (path: string, userId?: string) => {
  const call = request(server).get(path);
  return userId === undefined ? call : call.set('x-test-user', userId);
};

describe.each([
  ['handler-level', '/api/v1/handler/gated'],
  ['class-level', '/api/v1/klass/gated'],
  ['inherited from a base class', '/api/v1/inherited/gated'],
])('a route gated %s', (_label, path) => {
  it('admits a verified account', async () => {
    await asUser(path, VERIFIED_USER).expect(200);
  });

  it('refuses an unverified account with 403 EMAIL_NOT_VERIFIED', async () => {
    const response = await asUser(path, UNVERIFIED_USER).expect(403);
    const envelope = errorEnvelopeSchema.parse(response.body);
    expect(envelope.error.code).toBe('EMAIL_NOT_VERIFIED');
    // `api/errors.md` §4: a refusal says how to succeed.
    expect(envelope.error.message).toMatch(/confirm/i);
  });

  it('refuses a request with no principal at all', async () => {
    // Unreachable on a correctly declared route — the boot assertion refuses a
    // route that declares nothing, and `@Public()` with this decorator is a
    // contradiction. Reaching it means the pipeline is not what the guard
    // believes, and the safe answer to "I cannot tell who this is" on a route
    // that requires a verified account is refusal.
    const response = await asUser(path).expect(403);
    expect(errorEnvelopeSchema.parse(response.body).error.code).toBe('EMAIL_NOT_VERIFIED');
  });

  it('refuses a principal whose user row is gone', async () => {
    const response = await asUser(path, VANISHED_USER).expect(403);
    expect(errorEnvelopeSchema.parse(response.body).error.code).toBe('EMAIL_NOT_VERIFIED');
  });
});

describe('a route with no gate', () => {
  it('is reachable by an unverified account', async () => {
    // THE NEGATIVE CONTROL. Without this, a guard that refused every request
    // would pass every other test in this file. Ruling 58.
    await asUser('/api/v1/handler/open', UNVERIFIED_USER).expect(200);
  });

  it('is reachable with no principal at all', async () => {
    await request(server).get('/api/v1/ungated').expect(200);
  });

  it('reads no user row for an ungated route', async () => {
    // The gate costs one primary-key read, and it must cost nothing on the
    // routes it does not govern. A guard that looked the user up first and
    // checked the metadata second would pass every assertion above and add a
    // database read to every request in the application.
    let reads = 0;
    const counting: VerifiedEmailLookup = {
      user: {
        findUnique: () => {
          reads += 1;
          return Promise.resolve({ emailVerifiedAt: null, status: 'ACTIVE' });
        },
      },
    };
    const isolated = await buildGuardedApp({
      controllers: [UngatedController],
      providers: [
        Reflector,
        { provide: PRISMA, useValue: counting },
        { provide: APP_GUARD, useClass: FakePrincipalGuard },
        { provide: APP_GUARD, useClass: EmailVerifiedGuard },
      ],
    });
    await request(isolated.getHttpServer())
      .get('/api/v1/ungated')
      .set('x-test-user', UNVERIFIED_USER)
      .expect(200);
    await isolated.close();

    expect(reads).toBe(0);
  });
});

describe('what this guard governs today', () => {
  /**
   * RULING F, AS TWO ASSERTIONS RATHER THAN A SENTENCE — AND BOTH HALVES HAVE
   * NOW BEEN REPLACED RATHER THAN DELETED.
   *
   * Task 12 registered this guard globally, which falsified the first half.
   * **Task 13 falsified the second**: `POST /api/v1/organizations` carries
   * `@RequireVerifiedEmail()`, so the guard stops returning early and
   * `EMAIL_NOT_VERIFIED` gains a producer a caller can reach for the first
   * time. The assertion below went red naming the file, which is what it was
   * built to do — "this is what goes red on the day it does, forcing the
   * document to be revisited rather than quietly becoming true by accident".
   *
   * `security/authentication.md` §6's claim — "unverified users may sign in but
   * cannot create organisations" — is met by that decorator and by nothing
   * else, so what replaces the assertion has to pin **exactly which** handlers
   * carry it. A count would not: moving the decorator from `create` to `list`
   * keeps the count at one, satisfies §6's letter nowhere, and would leave
   * organisation creation open to unverified accounts.
   *
   * The refusal itself is proved against a real unverified account in
   * `organizations.integration.spec.ts`; this file proves the wiring.
   */
  it('is registered as a global guard, so a decorated route is governed at once', () => {
    // `AppModule` is imported statically at the top of this file rather than
    // with `await import(...)` here. The dynamic form worked until Task 13 and
    // then began **timing out at 5000ms in the whole-lane run while passing on
    // its own** — `OrganizationsModule` grew the module graph, and a dynamic
    // import inside a test body is charged to that test's timeout while the
    // lane's other workers compete for the CPU. Nothing about this assertion
    // depends on when the import happens; `app.module.spec.ts` has always read
    // the same metadata off a static import.
    const providers = (Reflect.getMetadata('providers', AppModule) ?? []) as {
      provide?: unknown;
      useClass?: unknown;
    }[];
    const guards = providers
      .filter((provider) => provider.provide === APP_GUARD)
      .map((provider) => provider.useClass);
    expect(guards).toContain(EmailVerifiedGuard);
  });

  it('governs exactly the routes that must be gated, and no others', () => {
    // Asserted against the CONTROLLER FILES, with comments stripped, rather
    // than by booting the application: the boot needs Postgres, Redis and a
    // validated environment, none of which this property depends on, and a
    // check that needs the world is a check somebody moves to a lane that does
    // not run. Comment-stripping is `require-mfa.spec.ts`'s technique and it is
    // here for the same reason — this file's own docblocks name the decorator
    // repeatedly, and a raw search would read the documentation as the thing it
    // documents the absence of.
    // `../..` from `src/common/guards/` is `src/`, which is what the pattern is
    // relative to. The `toBeGreaterThan(0)` below is not decoration: the first
    // version of this test globbed the wrong directory, found nothing, and
    // would have reported "no route carries the decorator" forever.
    // `node:fs`'s globSync has no `absolute` option — it returns paths relative
    // to `cwd` — so they are joined by hand rather than read from the process's
    // working directory, which differs between a whole-suite run and a single-file one.
    const root = fileURLToPath(new URL('../..', import.meta.url));
    const controllers = globSync('**/*.controller.ts', { cwd: root }).map((relative) =>
      join(root, relative),
    );
    // PINNED, not merely non-zero (the Task 12 review's L-3). A glob that found
    // 1 of 4 controllers would satisfy `toBeGreaterThan(0)` and still report
    // "no route carries the decorator" over three quarters of the API. The
    // wrong directory shipped once already, which is why the guard is here at
    // all — and the pin earned its keep again in Task 13, going red at
    // `expected [ …(4) ] to have a length of 3` when
    // `organizations.controller.ts` arrived.
    //
    // Auth, health, OpenAPI, organizations.
    expect(controllers).toHaveLength(4);

    const decorated = controllers.filter((file) =>
      readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
        .includes('@RequireVerifiedEmail('),
    );
    // Named, not counted. `security/authentication.md` §6 gates organisation
    // creation specifically, and Tasks 14-15 add inviting — each of which is a
    // deliberate addition to this list rather than a number that drifts up.
    expect(decorated.map((file) => basename(file))).toEqual(['organizations.controller.ts']);
  });
});
