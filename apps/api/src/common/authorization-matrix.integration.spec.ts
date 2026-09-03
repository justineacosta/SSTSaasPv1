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
import { CSRF_HEADER } from './guards/csrf.guard.js';
import { SESSION_COOKIE_NAME } from '../modules/auth/cookies.js';
import { deriveCsrfToken } from '../modules/auth/csrf-token.js';
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
 * # What this file can and cannot prove, stated precisely
 *
 * Through Task 12 the honest version of this paragraph read: "no route in this
 * API declares `@RequirePermission()`, so the 403 and cross-tenant-404 arms
 * below run against zero shipped routes". Task 13 changed that and Task 14
 * widened it. **Seven** routes now declare one, counted from
 * `EXPECTED_GUARDED_ROUTES` below rather than remembered: three on
 * `/organizations/:id` (Task 13), three on `/organizations/:id/members` and
 * `GET /roles` (Task 14).
 *
 * Three limits on that claim, all worth naming rather than leaving to be
 * inferred:
 *
 * - **Arm 2 is inapplicable for `organization.read`.** Every system role holds
 *   it, so no caller exists who could produce a 403 on `GET
 *   /organizations/:id` or on `GET /roles`. `rolesFor` returns `undefined` for
 *   the lacker and the arm records itself as run and evaluated rather than
 *   skipped. The other five routes produce real 403s.
 * - **Arm 3 runs one of two probes, declared per route.** See
 *   `crossTenantProbeFor`: a route with a tenant id in its path is probed
 *   against `assertPathIsActiveTenant`, and a route without one — `GET /roles`
 *   is the first — against `TenantContextGuard`. What neither probe covers is a
 *   correct path id carrying another tenant's *resource* id, which is proved
 *   per resource in the resource's own suite.
 * - **Arm 4 asserts "not refused", not 2xx.** A guarded `DELETE` on an
 *   organisation answers 409 and a `DELETE` of the caller's own sole `OWNER`
 *   membership answers 422; both are correct answers that say authorization
 *   admitted the request. Asserting 2xx would make the matrix refuse any
 *   endpoint whose business logic legitimately declines.
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
 * reason: the column is set directly through the owner client so that a role's
 * arms can be exercised without driving `switch-org` first, which would make
 * every case here depend on another endpoint's correctness. Before Task 13 the
 * reason was stronger — nothing wrote the column at all — and this comment said
 * that. Seeded by the owner because
 * `sentinel_app` cannot write outside a tenant transaction; the application
 * under test still connects as `sentinel_app`.
 */
interface Actor {
  readonly cookie: string;
  /** The raw session token, so an unsafe call can derive its CSRF header. */
  readonly token: string;
  readonly userId: string;
  readonly organizationId: string;
  /**
   * Their own membership row in that organisation.
   *
   * Added in Task 14, because `:membershipId` has to substitute to something
   * that exists inside the resolved tenant or arm 4 answers 404 for the wrong
   * reason — a refusal that looks exactly like the one arm 3 is asserting.
   */
  readonly membershipId: string;
}

async function member(options: { role: SystemRole }): Promise<Actor> {
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
  const membership = await owner.membership.create({
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
    token: minted.token,
    userId: user.id,
    organizationId: organization.id,
    membershipId: membership.id,
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
 * SUBSTITUTES THE PATH PARAMETERS OF A ROUTE FOR ONE ACTOR.
 *
 * The inventory holds Express paths, so a guarded route reads
 * `/api/v1/organizations/:id`. Requesting that literally sends the seven
 * characters `%3Aid` as an organisation id, which every arm answers 404 to —
 * and 404 is the fail-closed direction, so arms 1, 2 and 3 would all still
 * "pass" while testing nothing, and only arm 4 would notice. That is
 * carry-forward ruling 97's family exactly: a mutation that blinds the resolver
 * leaves the 404 arms green.
 *
 * **A parameter this map does not know is a hard failure, not a skip.** The
 * inversion is the whole design of this file: a new endpoint the arms cannot
 * describe must fail the build rather than be quietly passed over. Adding a
 * `:projectId` route in Phase 3 means adding a line here, and until somebody
 * does, the matrix refuses.
 */
function substitutePathParameters(path: string, actor: Actor): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, (_match, name: string) => {
    switch (name) {
      // Every `:id` in this API today is an organisation id, and for the three
      // guarded routes it must be **the actor's own** — `TenantContextGuard`
      // resolves the tenant from the session, and `assertPathIsActiveTenant`
      // answers 404 for any other value. Arm 3 gets its cross-tenant behaviour
      // from pointing the session elsewhere, not from changing this.
      case 'id':
        return actor.organizationId;
      // Task 14. **The actor's own membership, not an arbitrary id.** A made-up
      // membership id would answer 404 on every arm, and 404 is the fail-closed
      // direction (carry-forward ruling 97) — arms 1, 2 and 3 would go on
      // passing while arm 4 failed for a reason that has nothing to do with
      // authorization. With their own row, the only thing that can refuse arms
      // 2 and 3 is the guard chain, which is what they are named after.
      case 'membershipId':
        return actor.membershipId;
      default:
        throw new Error(
          `The matrix does not know what to substitute for ":${name}" in ${path}. ` +
            'Add it to substitutePathParameters rather than letting the route go unexercised — ' +
            'an unexercised route is what this file exists to fail on, and a literal ":param" ' +
            'answers 404, which is the direction that looks like a pass.',
        );
    }
  });
}

/**
 * The same call, carrying a session cookie AND a valid CSRF header.
 *
 * **The header is new, and its absence was a real hole rather than a
 * theoretical one.** `CsrfGuard` governs unsafe methods on cookie-authenticated
 * routes and runs *before* `AuthorizationGuard`, so an unsafe guarded route
 * reached with the cookie alone answers 403 `CSRF_TOKEN_INVALID` — which is the
 * same status arm 2 expects for a missing permission. Measured on the day Task
 * 13's routes arrived: `PATCH` and `DELETE /api/v1/organizations/:id` passed
 * arm 2 while authorization had not run at all. The previous version of this
 * docblock predicted the gap and left it open, because no unsafe guarded route
 * existed yet.
 *
 * Two things close it: the header below, and arm 2 now asserting the error
 * **code** rather than only the status.
 *
 * The value is derived from the raw session token, which is what `CsrfGuard`
 * compares against — not the CSRF cookie. See `csrf.guard.ts` on why that is a
 * deliberate strengthening of double-submit.
 */
/**
 * A minimal body that the route's own schema accepts, for the routes that
 * require one.
 *
 * **Why this has to exist at all.** Guards run before `ZodValidationPipe`, so an
 * empty body is correct for arms 1 and 2 — a refusal that depends on a
 * credential cannot depend on the body. It is NOT correct for arm 3, whose
 * subject is `assertPathIsActiveTenant`, a check inside the handler and
 * therefore *after* validation. Task 13's review, M3: with an empty body,
 * `PATCH /api/v1/organizations/:id` answers 400 from the pipe and arm 3 records
 * a route as exercised whose tenant check never ran.
 *
 * Deliberately a registry with a loud default rather than a schema-driven
 * generator. The matrix cannot synthesise a valid body for an arbitrary schema,
 * and a generator that produced *almost* valid bodies would fail in exactly the
 * silent way this file exists to prevent. An empty object is the default because
 * most routes take no body; arm 3 turns an unexpected 400 into a failure naming
 * this map, so a future route needing an entry cannot pass by accident.
 */
function bodyFor(route: RegisteredRoute): Record<string, unknown> {
  switch (`${route.method} ${route.path}`) {
    case 'PATCH /api/v1/organizations/:id':
      // `updateOrganizationRequestSchema` rejects `{}` by design — an empty
      // patch is a request that cannot be satisfied or refused meaningfully.
      return { name: 'Matrix probe' };
    case 'PATCH /api/v1/organizations/:id/members/:membershipId':
      // `OWNER`, deliberately, and it is the actor's OWN membership that
      // `substitutePathParameters` puts in the path. Arm 4's holder is an
      // `OWNER` and the only owner their organisation has, so any other value
      // here would be refused 422 by the last-owner invariant — a correct
      // answer, and one that would stop this arm from ever reaching a 200.
      // Setting the role a member already holds is applied and audited rather
      // than refused (`membership.service.ts`), so this is a real success.
      return { roleKey: 'OWNER' };
    default:
      return {};
  }
}

/**
 * WHICH CROSS-TENANT PROBE ARM 3 CAN ACTUALLY RUN AGAINST A ROUTE.
 *
 * Added in Task 14, because `GET /api/v1/roles` is the first guarded route in
 * this API with **no tenant-owned resource in its path**, and the probe Task 13
 * settled on cannot be run against it: pointing a real member of another
 * organisation at their own organisation id requires there to be an
 * organisation id in the path.
 *
 * Two probes, and each names the check it reaches:
 *
 * - **`path`** — the caller is a real, active member of the organisation their
 *   session names, and the path names a *different* organisation they are also
 *   a member of. Everything about the request is legitimate except that the
 *   path did not select the tenant, so the only thing that can refuse it is
 *   `assertPathIsActiveTenant`. This is the probe carry-forward ruling 109
 *   forced into existence: the earlier version pointed the stranger at an
 *   organisation they had no membership in, `TenantContextGuard` answered 404
 *   before any handler ran, and the check the arm is named after was never
 *   evaluated by anything.
 * - **`session`** — the caller's session names an organisation they hold no
 *   membership in. The refusal comes from `TenantContextGuard` itself, one
 *   layer earlier. For a route with no path id this is the whole of what
 *   "authenticated in a different tenant" can mean, and it is a real arm rather
 *   than a concession: it is the `not-a-member` row of `api/authorization.md`
 *   §3.
 *
 * **A guarded route missing from this map is a hard failure, not a default.**
 * Ruling 109's lesson is that the dangerous version of this arm is the one that
 * passes without reaching anything, so the choice is written down per route and
 * a new endpoint has to make it deliberately. Note what this map does NOT
 * cover: a path id that is legitimately the caller's own tenant but a
 * *resource* id belonging to another one — `assertPathIsActiveTenant` never
 * fires there and the handler's own lookup is what must answer 404. That case
 * is proved per resource in `memberships.integration.spec.ts` and
 * `organizations.scoped.integration.spec.ts`, because the matrix cannot know
 * what a resource of an arbitrary future route looks like.
 */
function crossTenantProbeFor(route: RegisteredRoute): 'path' | 'session' {
  switch (`${route.method} ${route.path}`) {
    case 'GET /api/v1/organizations/:id':
    case 'PATCH /api/v1/organizations/:id':
    case 'DELETE /api/v1/organizations/:id':
    case 'GET /api/v1/organizations/:id/members':
    case 'PATCH /api/v1/organizations/:id/members/:membershipId':
    case 'DELETE /api/v1/organizations/:id/members/:membershipId':
      return 'path';
    case 'GET /api/v1/roles':
      return 'session';
    default:
      throw new Error(
        `The matrix does not know which cross-tenant probe applies to ${route.method} ` +
          `${route.path}. Add it to crossTenantProbeFor rather than letting arm 3 guess — an ` +
          'arm that cannot reach the check it is named after passes while proving nothing, ' +
          'which is carry-forward ruling 109 and is what this map exists to prevent.',
      );
  }
}

async function callAs(route: RegisteredRoute, actor: Actor): Promise<request.Response> {
  await clearRateLimits(harness.redis);
  const path = substitutePathParameters(route.path, actor);
  const body = bodyFor(route);
  const call = (() => {
    switch (route.method) {
      case 'GET':
        return request(server).get(path);
      case 'POST':
        return request(server).post(path).send(body);
      case 'PUT':
        return request(server).put(path).send(body);
      case 'PATCH':
        return request(server).patch(path).send(body);
      case 'DELETE':
        return request(server).delete(path);
      default:
        throw new Error(`The matrix does not know how to call ${route.method}.`);
    }
  })();
  return call.set('Cookie', actor.cookie).set(CSRF_HEADER, deriveCsrfToken(actor.token));
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
   * THE FOUR ARMS THE EXIT CRITERION NAMES (this test guards arms 2-4):
   * unauthenticated → 401; authenticated without the permission → 403;
   * authenticated in a different tenant → 404; correct permission → success.
   *
   * **The set is no longer empty.** Task 13 shipped the first three guarded
   * routes — `GET`, `PATCH` and `DELETE /api/v1/organizations/:id` — so every
   * arm below runs against real endpoints, which is what the arms were written
   * ahead of time for. This docblock said the opposite until Task 13's review
   * caught it: it still claimed the set was empty, still named a test called
   * `there are none yet` that no longer exists, and still described Task 13 in
   * the future tense, fifteen lines above a test asserting the set is *not*
   * empty. A comment that survives the change it predicted is worse than no
   * comment, because it reads as current.
   *
   * The success arm asserts **not 401, not 403, not 404** rather than a 2xx. A
   * guarded `POST` reached with an empty body is a 400 from the validation
   * pipe, which is a correct answer that says authorization admitted it — and
   * this file cannot know a valid body for a route it has never seen. Asserting
   * 2xx would make the matrix refuse to accept any endpoint that takes input.
   */
  it('there is at least one, so the three arms below are not vacuous', () => {
    // THE SENTINEL, REPLACED RATHER THAN DELETED — carry-forward ruling 101's
    // instruction, followed. Its previous form asserted that NO route declared
    // a permission and named what had to replace it on the day one did. Task 13
    // is that day: it went red naming
    // `DELETE /api/v1/organizations/:id, GET /api/v1/organizations/:id,
    // PATCH /api/v1/organizations/:id`, which is the message doing its job.
    //
    // What replaces it has to be the *opposite* assertion, because the failure
    // mode has inverted. While the set was empty the danger was a green tick
    // implying coverage; now the danger is the set silently going back to empty
    // — a controller renamed, a module dropped from `AppModule`, a
    // `@RequirePermission()` downgraded to `@AuthenticatedOnly()` — after which
    // arms 2, 3 and 4 would loop over nothing and report green, exactly as they
    // did for all of Task 12.
    const guarded = routes.filter((route) => route.access?.kind === 'permission').map(key);
    expect(
      guarded,
      'No route declares a permission. Arms 2-4 below iterate over the guarded set, so an ' +
        'empty set makes all three pass without exercising anything — which is the state this ' +
        'API was in from Task 7 to Task 12. If a route was deliberately un-guarded, replace ' +
        'this assertion with one that names what now proves authorization, rather than deleting it.',
    ).not.toEqual([]);
  });

  /**
   * THE DOWNGRADE SENTINEL — the gap the test above cannot close.
   *
   * Task 13's review, M2, and it was admitted rather than fixed at the time.
   * The assertion above catches the guarded set going *fully* empty. It cannot
   * catch **one** route being downgraded from `@RequirePermission()` to
   * `@AuthenticatedOnly()`, because such a route simply leaves the set that
   * arms 2–4 iterate: the arms still run, still pass, and cover one endpoint
   * fewer than yesterday. Measured then — downgrading `organization.update`
   * turned exactly one unit test and one integration test red and left this
   * whole file green.
   *
   * A count would be weaker than it looks: adding a route while downgrading
   * another keeps the number identical. So the inventory is pinned by
   * `METHOD path -> permission`, which is the fact that actually matters and
   * the one a reader can check against the controllers.
   *
   * **This is a list that must be edited when routes are added, and that is the
   * design rather than a maintenance cost.** Carry-forward ruling 101: a
   * sentinel that fails on the day the feature arrives invites deletion, so it
   * has to say what to do instead of merely failing. Adding a guarded endpoint
   * turns this red with a message naming the new route; the fix is one line
   * here, and the alternative — deriving the expectation from the same
   * inventory it is checking — would assert nothing at all.
   */
  it('every guarded route declares the permission it is supposed to, and none has been downgraded', () => {
    const EXPECTED_GUARDED_ROUTES: Readonly<Record<string, string>> = {
      'GET /api/v1/organizations/:id': 'organization.read',
      'PATCH /api/v1/organizations/:id': 'organization.update',
      'DELETE /api/v1/organizations/:id': 'organization.delete',
      // Task 14. The member list declares `organization.manage_members` and not
      // `organization.read`, which the plan settled and which
      // `memberships.controller.ts` records the reasoning for: widening later
      // is additive, narrowing later is a breaking change to a shipped
      // contract.
      'GET /api/v1/organizations/:id/members': 'organization.manage_members',
      'PATCH /api/v1/organizations/:id/members/:membershipId': 'organization.manage_roles',
      'DELETE /api/v1/organizations/:id/members/:membershipId': 'organization.manage_members',
      // `organization.read` because every system role holds it and the role
      // picker is a thing you use *inside* an organisation. It is the first
      // guarded route in this API with no tenant-owned resource in its path,
      // which is why `crossTenantProbeFor` exists.
      'GET /api/v1/roles': 'organization.read',
    };

    // Built by hand rather than with `Object.fromEntries`, which is typed
    // `{ [k: string]: any }` and trips the no-unsafe-assignment rule — and the
    // rule is right: an `any` here would let a typo in `permission` pass the
    // comparison below without anyone noticing.
    const actual: Record<string, string> = {};
    for (const route of routes) {
      if (route.access?.kind !== 'permission') continue;
      actual[key(route)] = route.access.permission;
    }

    expect(
      actual,
      'The set of permission-guarded routes, or the permission one of them declares, has ' +
        'changed. If you ADDED a guarded route, add it to EXPECTED_GUARDED_ROUTES above — that ' +
        'is this assertion working. If a route DISAPPEARED from this list, a ' +
        '@RequirePermission() was downgraded to @AuthenticatedOnly() or removed, and arms 2-4 ' +
        'below now cover one endpoint fewer while still reporting green: that is the failure ' +
        'this test exists to catch, and it must not be fixed by editing the list.',
    ).toEqual(EXPECTED_GUARDED_ROUTES);
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
      const response = await callAs(route, actor);
      ran(route, 'no-permission');
      if (response.status !== 403) {
        failures.push(
          `${key(route)} answered ${String(response.status)} to a ${lacker}, expected 403`,
        );
      } else {
        // THE CODE, NOT ONLY THE STATUS. `CsrfGuard` answers 403
        // `CSRF_TOKEN_INVALID` and runs before `AuthorizationGuard`, so a 403
        // on an unsafe route says nothing on its own about whether
        // authorization ran — and for the first two days these routes existed
        // it was the CSRF guard answering. `PERMISSION_DENIED` can only come
        // from the authorization layer.
        const code = errorEnvelopeSchema.parse(response.body).error.code;
        if (code !== 'PERMISSION_DENIED') {
          failures.push(
            `${key(route)} answered 403 to a ${lacker} with code ${code}, expected PERMISSION_DENIED`,
          );
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('arm 3 — answers 404 to a member of a different tenant', async () => {
    const failures: string[] = [];
    for (const route of routes) {
      if (route.access?.kind !== 'permission') continue;
      // THE STRANGER MUST BE A REAL MEMBER OF THE ORGANISATION THEIR SESSION
      // POINTS AT, OR THIS ARM NEVER REACHES A HANDLER.
      //
      // Task 13's review, M3. The first version of this arm pointed the
      // stranger's session at an organisation they had no membership in, so
      // `TenantContextGuard` resolved `not-a-member` and answered 404 before
      // any handler ran. The arm passed, the coverage assertion recorded it as
      // exercised, and the path-id substitution below — the thing it exists to
      // probe — was never evaluated by anything. Proved by deleting
      // `assertPathIsActiveTenant` outright: five unit and five integration
      // tests went red across all three guarded routes, and this file stayed
      // green.
      //
      // With a membership in `other`, the guard resolves, the permission check
      // passes, and the ONLY thing wrong with the request is that the path
      // names a different organisation from the one the session is acting in.
      // That is the case §6 requires be indistinguishable from absence, and it
      // is the one that generalises to every future resource whose handler
      // compares a path id against the resolved tenant.
      //
      // WHICH of the two probes applies is declared per route in
      // `crossTenantProbeFor`, because Task 14 shipped the first guarded route
      // with no tenant-owned resource in its path. See that function.
      const probe = crossTenantProbeFor(route);
      const stranger = await member({ role: 'OWNER' });
      const other = await member({ role: 'OWNER' });
      if (probe === 'path') {
        const ownerRole = await harness.prisma.role.findUniqueOrThrow({
          where: { key: 'OWNER' },
          select: { id: true },
        });
        await harness.prisma.membership.create({
          data: {
            id: newId('mbr'),
            organizationId: other.organizationId,
            userId: stranger.userId,
            roleId: ownerRole.id,
            status: 'ACTIVE',
            deletedAt: null,
          },
          select: { id: true },
        });
      }
      // For the `session` probe the membership above is deliberately NOT
      // created: the stranger's session is pointed at an organisation they hold
      // no membership in, and `TenantContextGuard` is what refuses. That is the
      // only cross-tenant condition a route with no path id can be put in.
      await harness.prisma.session.updateMany({
        where: { userId: stranger.userId },
        data: { activeOrganizationId: other.organizationId },
      });
      // The path is substituted with the STRANGER's own organisation id, which
      // is the sharper probe: the id is real, the caller is a real member of
      // it, and the only thing wrong is that their session is pointed
      // elsewhere. A made-up id would be refused by a check that had never
      // consulted membership at all.
      const response = await callAs(route, stranger);
      ran(route, 'other-tenant');
      if (response.status === 400) {
        // The pipe rejected the body, so the handler — and with it the
        // path-versus-tenant check this arm exists to probe — never ran. This
        // is the silent pass M3 found, made loud.
        failures.push(
          `${key(route)} answered 400 cross-tenant: the request body was rejected before the ` +
            'handler ran, so this arm proved nothing. Add a valid minimal body for it to ' +
            'bodyFor() rather than leaving the tenant check unexercised.',
        );
      } else if (response.status !== 404) {
        failures.push(
          `${key(route)} answered ${String(response.status)} cross-tenant, expected 404`,
        );
      } else {
        const code = errorEnvelopeSchema.parse(response.body).error.code;
        if (code !== 'RESOURCE_NOT_FOUND') {
          failures.push(`${key(route)} answered 404 cross-tenant with code ${code}`);
        }
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
      const response = await callAs(route, actor);
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
