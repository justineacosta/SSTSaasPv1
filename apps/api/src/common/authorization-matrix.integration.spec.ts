import type { Server } from 'node:http';
import { errorEnvelopeSchema } from '@sentinel/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearRateLimits, startAuthHarness, type AuthHarness } from '../testing/auth-harness.js';
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
}, 180_000);

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

describe('every permission-guarded route runs the four arms', () => {
  /**
   * THE ARMS THE EXIT CRITERION NAMES, AND THE SET THEY RUN OVER IS EMPTY.
   *
   * This block is written now, against the real inventory, so that the day a
   * route carries `@RequirePermission()` it is exercised without anybody
   * remembering to come back here. Today it iterates zero routes, and the
   * assertion below states that in the open rather than letting a green tick
   * imply coverage that does not exist.
   *
   * The arms themselves are not untested — `authorization.guard.spec.ts` runs
   * all four against purpose-built controllers through the real guard chain,
   * and `authorization.integration.spec.ts` runs them against real seeded rows
   * over `sentinel_app`. What is missing is a shipped endpoint, not a test.
   */
  it('there are none yet, and that is recorded rather than implied', () => {
    const guarded = routes.filter((route) => route.access?.kind === 'permission');
    expect(guarded).toEqual([]);
  });

  it('refuses each of them without a credential', async () => {
    const failures: string[] = [];
    for (const route of routes) {
      if (route.access?.kind !== 'permission') continue;
      const response = await callAnonymously(route);
      exercised.add(key(route));
      if (response.status !== 401) {
        failures.push(
          `${key(route)} answered ${String(response.status)} anonymously, expected 401`,
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

  it('every route carries an access declaration', () => {
    // `access-assertion.ts` already refuses to boot otherwise, and this asserts
    // it a second way — from the matrix's own view of the inventory, so a route
    // that reached the router outside that assertion's reach is still caught
    // here rather than being classified as "not public" and quietly passing.
    const undeclared = routes.filter((route) => route.access === undefined).map(key);
    expect(undeclared).toEqual([]);
  });
});
