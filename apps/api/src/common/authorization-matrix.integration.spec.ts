import type { Server } from 'node:http';
import {
  errorEnvelopeSchema,
  ROLE_PERMISSIONS,
  SYSTEM_ROLES,
  type Permission,
  type SystemRole,
} from '@sentinel/contracts';
import { newId } from '@sentinel/db';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedReferenceData } from '@sentinel/db';
import { clearRateLimits, startAuthHarness, type AuthHarness } from '../testing/auth-harness.js';
import { SESSION_COOKIE_NAME } from '../modules/auth/cookies.js';
import { mintSecretToken } from '../modules/auth/secret-token.js';
import { describeRoutes, type RegisteredRoute } from './route-inventory.js';

/**
 * THE AUTHORIZATION MATRIX, GENERATED FROM THE ROUTE TABLE.
 *
 * `security/authorization.md` §10 and `api/authorization.md` §6 both ask for
 * the same thing and the Phase 2 exit criteria name it: "for every route:
 * unauthenticated → 401; authenticated without the permission → 403;
 * authenticated in a different tenant → 404; correct permission → success",
 * generated "so a new endpoint gets tests automatically and an endpoint without
 * them fails CI".
 *
 * # The inversion is the whole design, and it is the last describe block
 *
 * A matrix that enumerates routes and asserts something about each is a
 * checklist wearing a matrix's name: the failure mode is a route the
 * enumeration silently skips. What makes this a matrix is that **every route in
 * the inventory must be classified and exercised**, and the coverage assertion
 * at the bottom fails when one is not. A new endpoint is covered the moment it
 * is written, and an endpoint the arms below cannot describe is a build
 * failure rather than a gap.
 *
 * # What this file can and cannot prove today, stated precisely
 *
 * **No route in this API declares `@RequirePermission()`.** All eighteen are
 * `@Public()` or `@AuthenticatedOnly()`; the first permission-guarded endpoints
 * are Tasks 13–15's. So the 403 and cross-tenant-404 arms below **run against
 * zero shipped routes** — the arms exist, they are exercised against
 * purpose-built controllers in `authorization.guard.spec.ts` and
 * `tenant-context.spec.ts`, and they will begin governing real endpoints
 * without further work the moment one carries the decorator.
 *
 * That is a smaller claim than "the matrix passes for every existing endpoint"
 * sounds, and it is the honest one. What this file proves about the shipped
 * API is that every non-public route refuses an unauthenticated caller, and
 * that no route escapes classification.
 *
 * # It drives the application as `sentinel_app`
 *
 * Carry-forward ruling 75, which named Task 12 as the task it binds hardest.
 * The harness's default is the schema owner, a superuser that bypasses
 * row-level security, so an authorization suite run under it would prove that
 * Postgres has policies rather than that this code obeys them.
 * `connectAs: 'app'` binds the application to the least-privileged role the API
 * process really uses.
 */

let harness: AuthHarness;
let server: Server;
let routes: RegisteredRoute[];

beforeAll(async () => {
  harness = await startAuthHarness({ connectAs: 'app' });
  server = harness.server;
  routes = describeRoutes(harness.app);
  // The system roles and their grants have to exist before any arm below can
  // resolve a permission set.
  await seedReferenceData(harness.prisma);
}, 240_000);

let counter = 0;

/**
 * One organisation, one user, one membership at the given role, and a live
 * session already pointed at that organisation.
 *
 * The same fixture `authorization.integration.spec.ts` uses, and for the same
 * reason: nothing writes `Session.activeOrganizationId` until Task 13, so the
 * column is set directly through the owner client. Seeded by the owner because
 * `sentinel_app` cannot write outside a tenant transaction; the application
 * under test still connects as `sentinel_app`.
 */
async function member(options: {
  role: SystemRole;
}): Promise<{ cookie: string; userId: string; organizationId: string }> {
  counter += 1;
  const suffix = `${String(counter)}-${String(Date.now())}`;
  const owner = harness.prisma;

  const organization = await owner.organization.create({
    data: { id: newId('org'), slug: `matrix-${suffix}`, name: `Matrix ${suffix}` },
    select: { id: true },
  });
  const user = await owner.user.create({
    data: {
      id: newId('usr'),
      email: `matrix-${suffix}@example.test`,
      emailVerifiedAt: new Date(),
      status: 'ACTIVE',
    },
    select: { id: true },
  });
  const role = await owner.role.findUniqueOrThrow({
    where: { key: options.role },
    select: { id: true },
  });
  await owner.membership.create({
    data: {
      id: newId('mbr'),
      organizationId: organization.id,
      userId: user.id,
      roleId: role.id,
      status: 'ACTIVE',
      deletedAt: null,
    },
    select: { id: true },
  });

  const minted = mintSecretToken();
  const now = Date.now();
  await owner.session.create({
    data: {
      id: newId('ses'),
      userId: user.id,
      tokenHash: minted.tokenHash,
      activeOrganizationId: organization.id,
      status: 'ACTIVE',
      idleExpiresAt: new Date(now + 24 * 60 * 60 * 1000),
      absoluteExpiresAt: new Date(now + 7 * 24 * 60 * 60 * 1000),
    },
  });

  return {
    cookie: `${SESSION_COOKIE_NAME}=${minted.token}`,
    userId: user.id,
    organizationId: organization.id,
  };
}

afterAll(async () => {
  await harness?.stop();
});

/** Routes the matrix has actually exercised, for the coverage assertion. */
const exercised = new Set<string>();

const key = (route: RegisteredRoute): string => `${route.method} ${route.path}`;

/**
 * Issues the route's own method at its own path with no credential at all.
 *
 * An empty body is deliberate and is not a shortcut: every guard in
 * `architecture/backend.md` §3's pipeline runs **before** `ZodValidationPipe`,
 * so a refusal that depends on a credential cannot depend on the body. A route
 * that answered 400 here would be a route whose validation ran ahead of its
 * authentication, which is itself the defect worth catching.
 */
async function callAnonymously(route: RegisteredRoute): Promise<request.Response> {
  // THE LIMITER RUNS BEFORE AUTHENTICATION, so a route whose window is spent
  // answers 429 and the caller never learns they were unauthenticated. That is
  // `architecture/backend.md` §3's deliberate order and not a defect — but it
  // makes the limiter a variable in a suite that is about authorization, and
  // carry-forward ruling 33 records that the compose Redis is shared with every
  // other integration suite and with a developer's running application. Cleared
  // per request rather than per block: `mfaManagement` allows ten an hour per IP
  // and every request here arrives from loopback, so one pass over eighteen
  // routes exhausts several classes on its own.
  //
  // This was found by the whole-lane run, not by the file on its own — running
  // this spec alone passed while `pnpm test:integration` reported
  // `POST /auth/mfa/enroll answered 429, expected 401`.
  await clearRateLimits(harness.redis);
  const path = route.path;
  switch (route.method) {
    case 'GET':
      return request(server).get(path);
    case 'POST':
      return request(server).post(path).send({});
    case 'PUT':
      return request(server).put(path).send({});
    case 'PATCH':
      return request(server).patch(path).send({});
    case 'DELETE':
      return request(server).delete(path);
    default:
      throw new Error(
        `The matrix does not know how to call ${route.method}. Add an arm rather than ` +
          'letting the route go unexercised — an unexercised route is what this file exists to fail on.',
      );
  }
}

/**
 * The same call, carrying a session cookie. CSRF is not in the way: every
 * permission-guarded route this matrix will meet is reached here with the
 * cookie alone, and `CsrfGuard` governs unsafe methods on cookie-authenticated
 * routes — so an unsafe guarded route would answer 403 `CSRF_TOKEN_INVALID`
 * before authorization ran. That is a real gap in arms 2 and 4 for unsafe
 * methods and it is recorded rather than papered over: the first guarded route
 * Task 13 ships is `GET /api/v1/organizations`, and whoever ships an unsafe one
 * has to teach this helper to mint a CSRF pair.
 */
async function callAs(route: RegisteredRoute, cookie: string): Promise<request.Response> {
  await clearRateLimits(harness.redis);
  const path = route.path;
  const call = (() => {
    switch (route.method) {
      case 'GET':
        return request(server).get(path);
      case 'POST':
        return request(server).post(path).send({});
      case 'PUT':
        return request(server).put(path).send({});
      case 'PATCH':
        return request(server).patch(path).send({});
      case 'DELETE':
        return request(server).delete(path);
      default:
        throw new Error(`The matrix does not know how to call ${route.method}.`);
    }
  })();
  return call.set('Cookie', cookie);
}

describe('every non-public route refuses an unauthenticated caller with 401', () => {
  it('has at least one such route, so this block cannot pass vacuously', () => {
    // Carry-forward ruling 58: a spec whose fixtures all sit on one side of the
    // branch under test cannot fail for the right reason. If every route were
    // public, the loop below would assert nothing and report green.
    expect(routes.filter((route) => route.access?.kind !== 'public').length).toBeGreaterThan(0);
  });

  it('refuses each of them', async () => {
    const failures: string[] = [];
    for (const route of routes) {
      if (route.access?.kind === 'public') continue;
      const response = await callAnonymously(route);
      exercised.add(key(route));
      if (response.status !== 401) {
        failures.push(`${key(route)} answered ${String(response.status)}, expected 401`);
      } else {
        // Parsed through the published envelope rather than read off an `any`:
        // a 401 whose body is not an error envelope is itself a defect, and
        // optional chaining into `any` would report it as `undefined` and move
        // on.
        const code = errorEnvelopeSchema.parse(response.body).error.code;
        if (code !== 'UNAUTHENTICATED' && code !== 'SESSION_EXPIRED') {
          failures.push(`${key(route)} answered 401 with code ${code}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });
});

describe('every public route reaches past authentication', () => {
  it('does not answer 401 to an anonymous caller', async () => {
    const failures: string[] = [];
    for (const route of routes) {
      if (route.access?.kind !== 'public') continue;
      const response = await callAnonymously(route);
      exercised.add(key(route));
      // NOT an assertion of 2xx. A public POST with an empty body is a
      // validation failure by design, and a rate-limited one may be 429 — both
      // are correct answers that say authentication did not refuse it. What
      // must never appear is 401.
      if (response.status === 401) {
        failures.push(`${key(route)} is @Public() and answered 401`);
      }
    }
    expect(failures).toEqual([]);
  });
});

/**
 * Which arms a route was actually put through. **This is what makes the block
 * below a matrix rather than a checklist**, together with the coverage
 * assertion at the bottom of the file.
 *
 * The Task 12 review's M-2: the first version of this file declared a block
 * named "every permission-guarded route runs the four arms" that contained one
 * arm. The reviewer added a `@RequirePermission()` route, watched it be
 * exercised by the 401 arm alone, watched the coverage assertion count it as
 * covered, and found that the only failure was a sentinel whose natural
 * disposition was deletion. Recording arms per route rather than routes per
 * matrix is what stops that: a guarded route that ran one arm now fails the
 * same way an unexercised route does.
 */
const armsRun = new Map<string, Set<string>>();

const ran = (route: RegisteredRoute, arm: string): void => {
  const existing = armsRun.get(key(route)) ?? new Set<string>();
  existing.add(arm);
  armsRun.set(key(route), existing);
  exercised.add(key(route));
};

/**
 * A role that holds the permission, and one that does not.
 *
 * Computed from `ROLE_PERMISSIONS` rather than hard-coded, so a new permission
 * needs no edit here. `holder` is always `OWNER`, which holds everything.
 * `lacker` is `undefined` for a permission every role holds — `organization.read`
 * and `notification.manage` are the two — and the 403 arm is then genuinely
 * inapplicable rather than skipped: there is no role that could produce it.
 */
function rolesFor(permission: Permission): {
  holder: SystemRole;
  lacker: SystemRole | undefined;
} {
  return {
    holder: 'OWNER',
    lacker: SYSTEM_ROLES.find((role) => !ROLE_PERMISSIONS[role].includes(permission)),
  };
}

describe('every permission-guarded route runs all four arms', () => {
  /**
   * THE FOUR ARMS THE EXIT CRITERION NAMES:
   * unauthenticated → 401; authenticated without the permission → 403;
   * authenticated in a different tenant → 404; correct permission → success.
   *
   * **The set is empty today** — no shipped route declares `@RequirePermission()`,
   * and `there are none yet` below states that rather than letting a green tick
   * imply coverage. But the arms are now *written*, so the day Task 13 ships a
   * guarded endpoint every one of them runs against it with no edit here.
   *
   * The success arm asserts **not 401, not 403, not 404** rather than a 2xx. A
   * guarded `POST` reached with an empty body is a 400 from the validation
   * pipe, which is a correct answer that says authorization admitted it — and
   * this file cannot know a valid body for a route it has never seen. Asserting
   * 2xx would make the matrix refuse to accept any endpoint that takes input.
   */
  it('there are none yet, and that is recorded rather than implied', () => {
    // Deliberately NOT the sentinel it replaces. The old version asserted the
    // empty set and nothing else, so on the day it went red the cheapest way
    // out was to delete it. This one names what has to happen instead.
    const guarded = routes.filter((route) => route.access?.kind === 'permission').map(key);
    if (guarded.length > 0) {
      throw new Error(
        `${String(guarded.length)} route(s) now declare a permission: ${guarded.join(', ')}. ` +
          'That is expected from Task 13 onward. Do not delete this assertion — remove it only ' +
          'together with a check that the arms below actually ran, which the coverage block at ' +
          'the bottom of this file already performs per arm.',
      );
    }
    expect(guarded).toEqual([]);
  });

  it('arm 1 — refuses each of them without a credential (401)', async () => {
    const failures: string[] = [];
    for (const route of routes) {
      if (route.access?.kind !== 'permission') continue;
      const response = await callAnonymously(route);
      ran(route, 'unauthenticated');
      if (response.status !== 401) {
        failures.push(
          `${key(route)} answered ${String(response.status)} anonymously, expected 401`,
        );
      }
    }
    expect(failures).toEqual([]);
  });

  it('arm 2 — refuses a member whose role lacks the permission (403)', async () => {
    const failures: string[] = [];
    for (const route of routes) {
      if (route.access?.kind !== 'permission') continue;
      const { lacker } = rolesFor(route.access.permission);
      if (lacker === undefined) {
        // Every role holds it, so no caller can produce a 403 on this route.
        // Recorded as run rather than skipped: the arm was evaluated and found
        // inapplicable, which is a different thing from never being written.
        ran(route, 'no-permission');
        continue;
      }
      const actor = await member({ role: lacker });
      const response = await callAs(route, actor.cookie);
      ran(route, 'no-permission');
      if (response.status !== 403) {
        failures.push(
          `${key(route)} answered ${String(response.status)} to a ${lacker}, expected 403`,
        );
      }
    }
    expect(failures).toEqual([]);
  });

  it('arm 3 — answers 404 to a member of a different tenant', async () => {
    const failures: string[] = [];
    for (const route of routes) {
      if (route.access?.kind !== 'permission') continue;
      // An OWNER of their own organisation, whose session has been pointed at
      // somebody else's. A real credential, a real organisation, no membership
      // — which is the cross-tenant case §6 requires be indistinguishable from
      // absence.
      const stranger = await member({ role: 'OWNER' });
      const other = await member({ role: 'OWNER' });
      await harness.prisma.session.updateMany({
        where: { userId: stranger.userId },
        data: { activeOrganizationId: other.organizationId },
      });
      const response = await callAs(route, stranger.cookie);
      ran(route, 'other-tenant');
      if (response.status !== 404) {
        failures.push(
          `${key(route)} answered ${String(response.status)} cross-tenant, expected 404`,
        );
      }
    }
    expect(failures).toEqual([]);
  });

  it('arm 4 — admits a member whose role holds the permission', async () => {
    const failures: string[] = [];
    for (const route of routes) {
      if (route.access?.kind !== 'permission') continue;
      const { holder } = rolesFor(route.access.permission);
      const actor = await member({ role: holder });
      const response = await callAs(route, actor.cookie);
      ran(route, 'holder');
      // Not an assertion of 2xx — see the block docblock. What must never
      // appear is a refusal from the authorization pipeline.
      if ([401, 403, 404].includes(response.status)) {
        failures.push(
          `${key(route)} answered ${String(response.status)} to a ${holder}, which holds ` +
            `${route.access.permission}`,
        );
      }
    }
    expect(failures).toEqual([]);
  });
});

describe('the matrix covers the whole inventory', () => {
  /**
   * THE INVERSION. "A new endpoint with no matrix coverage must fail the test,
   * not be silently skipped — that inversion is the difference between a matrix
   * and a checklist."
   *
   * Runs last so the `exercised` set is complete. Vitest runs a file's blocks
   * in declaration order, and this depends on that.
   */
  it('exercised every route the application registered', () => {
    const uncovered = routes.map(key).filter((route) => !exercised.has(route));
    expect(uncovered).toEqual([]);
  });

  it('exercised no route the application did not register', () => {
    // The other direction, so a stale entry cannot inflate the coverage count.
    const inventory = new Set(routes.map(key));
    expect([...exercised].filter((route) => !inventory.has(route))).toEqual([]);
  });

  it('ran all four arms against every permission-guarded route', () => {
    // M-2's inversion, at arm granularity. A guarded route that ran one arm is
    // as much a coverage hole as a route that ran none, and the first version
    // of this file could not tell the difference.
    const required = ['unauthenticated', 'no-permission', 'other-tenant', 'holder'];
    const incomplete = routes
      .filter((route) => route.access?.kind === 'permission')
      .map((route) => ({
        route: key(route),
        missing: required.filter((arm) => !(armsRun.get(key(route)) ?? new Set()).has(arm)),
      }))
      .filter((entry) => entry.missing.length > 0);
    expect(incomplete).toEqual([]);
  });

  it('every route carries an access declaration', () => {
    // `access-assertion.ts` already refuses to boot otherwise, and this asserts
    // it a second way — from the matrix's own view of the inventory, so a route
    // that reached the router outside that assertion's reach is still caught
    // here rather than being classified as "not public" and quietly passing.
    const undeclared = routes.filter((route) => route.access === undefined).map(key);
    expect(undeclared).toEqual([]);
  });
});
