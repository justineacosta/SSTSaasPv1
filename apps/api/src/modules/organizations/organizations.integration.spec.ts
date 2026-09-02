import type { Server } from 'node:http';
import {
  errorEnvelopeSchema,
  organizationCollectionSchema,
  organizationResponseSchema,
  type ErrorEnvelope,
  type SystemRole,
} from '@sentinel/contracts';
import { newId, seedReferenceData } from '@sentinel/db';
import type { PrismaClient } from '@sentinel/db/unscoped';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startAuthHarness, type AuthHarness } from '../../testing/auth-harness.js';
import { CSRF_HEADER } from '../../common/guards/csrf.guard.js';
import { SESSION_COOKIE_NAME } from '../auth/cookies.js';
import { deriveCsrfToken } from '../auth/csrf-token.js';
import { mintSecretToken } from '../auth/secret-token.js';

/**
 * THE FIVE ORGANISATION ENDPOINTS, AGAINST REAL ROW-LEVEL SECURITY, THE REAL
 * GUARD CHAIN AND REAL SEEDED ROWS.
 *
 * # It connects as `sentinel_app`, and without that it proves nothing
 *
 * Carry-forward ruling 58 and ruling 75. The harness's default `PRISMA` is the
 * schema owner, a superuser that **bypasses row-level security**, so a suite
 * run under it would show that Postgres has policies rather than that this code
 * obeys them — measured in Task 9, where deleting `withTenantTransaction` from
 * a lookup left both lanes green. `connectAs: 'app'` binds the application to
 * the least-privileged role the API process really uses. Fixtures are seeded
 * through the owner client, which is the one thing the owner is right for.
 *
 * That choice is what makes ADR-0020 testable here at all: `GET /organizations`
 * over the owner would work whether or not `user_organizations(text)` exists,
 * because the owner can read `Membership` across organisations by itself.
 *
 * # These are the first shipped routes to declare a permission
 *
 * Until Task 13 every route in this API was `@Public()` or
 * `@AuthenticatedOnly()`, so layers 2–4 of `security/authorization.md` §2
 * governed nothing (carry-forward ruling 93). The 403 and cross-tenant-404 arms
 * below are the first time those layers refuse a caller on a production
 * endpoint.
 *
 * **Carry-forward ruling 93 also constrains what counts as evidence here.** An
 * empty permission set proves nothing about resolution, because it is also what
 * an unresolved tenant produces. Every arm below asserts something that could
 * only come from a resolved tenant: a 200 body, a 403 naming the permission, or
 * a 404 where a 200 would otherwise be.
 */

const envelopeOf = (body: unknown): ErrorEnvelope => errorEnvelopeSchema.parse(body);
const codeOf = (body: unknown): string => envelopeOf(body).error.code;

let harness: AuthHarness;
let owner: PrismaClient;
let server: Server;

beforeAll(async () => {
  harness = await startAuthHarness({ connectAs: 'app' });
  owner = harness.prisma;
  server = harness.server;
  await seedReferenceData(owner);
}, 240_000);

afterAll(async () => {
  await harness?.stop();
});

let counter = 0;
const unique = (): string => {
  counter += 1;
  return `${String(counter)}-${String(Date.now())}`;
};

interface Actor {
  readonly cookie: string;
  /** The raw session token, so a test can derive the CSRF header the real way. */
  readonly token: string;
  readonly userId: string;
  readonly sessionId: string;
}

/**
 * A signed-in user, optionally already acting in an organisation.
 *
 * `activeOrganizationId` is written directly through the owner client where a
 * test needs a session already pointed somewhere. `POST /auth/switch-org` is
 * what writes it in production and is exercised in its own suite; using it here
 * would make every organisation test depend on that endpoint being correct.
 */
async function signedIn(options: {
  emailVerified?: boolean;
  activeOrganizationId?: string | null;
}): Promise<Actor> {
  const suffix = unique();
  const user = await owner.user.create({
    data: {
      id: newId('usr'),
      email: `orgs-${suffix}@example.test`,
      emailVerifiedAt: (options.emailVerified ?? true) ? new Date() : null,
      status: 'ACTIVE',
    },
    select: { id: true },
  });

  // Minted by the real generator, so the row carries a token of exactly the
  // shape `SessionService.resolve` will hash and look up.
  const minted = mintSecretToken();
  const now = Date.now();
  const session = await owner.session.create({
    data: {
      id: newId('ses'),
      userId: user.id,
      tokenHash: minted.tokenHash,
      activeOrganizationId: options.activeOrganizationId ?? null,
      status: 'ACTIVE',
      idleExpiresAt: new Date(now + 24 * 60 * 60 * 1000),
      absoluteExpiresAt: new Date(now + 7 * 24 * 60 * 60 * 1000),
    },
    select: { id: true },
  });

  return {
    cookie: `${SESSION_COOKIE_NAME}=${minted.token}`,
    token: minted.token,
    userId: user.id,
    sessionId: session.id,
  };
}

/** An organisation with one membership, seeded directly. */
async function organizationFor(options: {
  userId: string;
  role?: SystemRole;
  status?: 'ACTIVE' | 'SUSPENDED';
  membershipStatus?: 'ACTIVE' | 'REMOVED';
}): Promise<string> {
  const suffix = unique();
  const organization = await owner.organization.create({
    data: {
      id: newId('org'),
      slug: `orgs-${suffix}`,
      name: `Orgs ${suffix}`,
      status: options.status ?? 'ACTIVE',
    },
    select: { id: true },
  });
  const role = await owner.role.findUniqueOrThrow({
    where: { key: options.role ?? 'OWNER' },
    select: { id: true },
  });
  const membershipStatus = options.membershipStatus ?? 'ACTIVE';
  await owner.membership.create({
    data: {
      id: newId('mbr'),
      organizationId: organization.id,
      userId: options.userId,
      roleId: role.id,
      status: membershipStatus,
      // Carry-forward ruling 10: `status` and `deletedAt` are one fact and the
      // CHECK constraint refuses a `REMOVED` row that is not soft-deleted.
      deletedAt: membershipStatus === 'REMOVED' ? new Date() : null,
    },
    select: { id: true },
  });
  return organization.id;
}

const csrf = (actor: Actor): Record<string, string> => ({
  Cookie: actor.cookie,
  // `CsrfGuard` compares the header against `deriveCsrfToken(sessionToken)`,
  // NOT against the CSRF cookie — a deliberate strengthening of double-submit,
  // because comparing header to cookie compares two values a cookie-injecting
  // attacker controls both of. Deriving it here the same way is what makes this
  // a real request rather than one that happens to satisfy a weaker check.
  [CSRF_HEADER]: deriveCsrfToken(actor.token),
});

describe('POST /api/v1/organizations', () => {
  it('creates the organisation, an OWNER membership and one audit event, in one transaction', async () => {
    const actor = await signedIn({});
    const slug = `create-${unique()}`;

    const response = await request(server)
      .post('/api/v1/organizations')
      .set(csrf(actor))
      .send({ name: 'Acme Security', slug });

    expect(response.status).toBe(201);
    const body = organizationResponseSchema.parse(response.body);
    expect(body.slug).toBe(slug);
    expect(body.status).toBe('ACTIVE');

    // D2, end to end and over `sentinel_app`: all three inserts satisfied their
    // policies inside one `withTenantTransaction` scoped to an id that did not
    // exist when the transaction opened.
    const membership = await owner.membership.findFirstOrThrow({
      where: { organizationId: body.id, userId: actor.userId, deletedAt: null },
      select: { status: true, role: { select: { key: true } } },
    });
    expect(membership.status).toBe('ACTIVE');
    expect(membership.role.key).toBe('OWNER');

    const events = await owner.auditEvent.findMany({
      where: { organizationId: body.id },
      select: {
        action: true,
        actorType: true,
        actorId: true,
        resourceType: true,
        resourceId: true,
      },
    });
    expect(events).toEqual([
      {
        action: 'ORGANIZATION_CREATED',
        actorType: 'USER',
        actorId: actor.userId,
        resourceType: 'Organization',
        resourceId: body.id,
      },
    ]);
  });

  it('leaves the new organisation invisible to sentinel_app outside a tenant transaction', async () => {
    // The property every read in this module depends on, asserted against the
    // role the API really connects as. `Organization` carries FORCE ROW LEVEL
    // SECURITY keyed on `id`, so a handler that skipped `withTenantTransaction`
    // would answer `null` for a row that exists — which is exactly what
    // `active-organization.store.ts` measured and what makes this suite's
    // `connectAs: 'app'` load-bearing rather than decorative.
    const actor = await signedIn({});
    const response = await request(server)
      .post('/api/v1/organizations')
      .set(csrf(actor))
      .send({ name: 'Invisible', slug: `invisible-${unique()}` });
    expect(response.status).toBe(201);
    const id = organizationResponseSchema.parse(response.body).id;

    const asApp = await harness.appPrisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM "Organization" WHERE id = ${id}
    `;
    expect(asApp).toEqual([]);
    // And the owner, which bypasses RLS, sees it — so the empty result above is
    // the policy rather than a failed insert.
    expect(await owner.organization.findUnique({ where: { id }, select: { id: true } })).toEqual({
      id,
    });
  });

  it('refuses an unverified address with 403 EMAIL_NOT_VERIFIED', async () => {
    // THE FIRST TIME `EmailVerifiedGuard` REFUSES ANYBODY. It was built in Task
    // 8 and registered in Task 12 with no handler carrying
    // `@RequireVerifiedEmail()`, so it was an opt-in control that had never
    // fired. `security/authentication.md` §6: "Unverified users may sign in but
    // cannot create organisations."
    const actor = await signedIn({ emailVerified: false });
    const response = await request(server)
      .post('/api/v1/organizations')
      .set(csrf(actor))
      .send({ name: 'Unverified', slug: `unverified-${unique()}` });

    expect(response.status).toBe(403);
    expect(codeOf(response.body)).toBe('EMAIL_NOT_VERIFIED');
    // Nothing was created. A gate that refuses after the write is not a gate.
    expect(await owner.membership.count({ where: { userId: actor.userId } })).toBe(0);
  });

  it('answers 409 for a slug that is already taken, and leaves nothing behind', async () => {
    // D3: the constraint decides, not a pre-check. What this asserts beyond the
    // status code is that the losing transaction rolled back completely — a
    // `create` that had written the membership before the organisation would
    // leave an orphan, and the unique index would still have produced a 409.
    const first = await signedIn({});
    const second = await signedIn({});
    const slug = `taken-${unique()}`;

    const ok = await request(server)
      .post('/api/v1/organizations')
      .set(csrf(first))
      .send({ name: 'First', slug });
    expect(ok.status).toBe(201);

    const clash = await request(server)
      .post('/api/v1/organizations')
      .set(csrf(second))
      .send({ name: 'Second', slug });

    expect(clash.status).toBe(409);
    expect(codeOf(clash.body)).toBe('DUPLICATE_RESOURCE');
    expect(await owner.membership.count({ where: { userId: second.userId } })).toBe(0);
    expect(await owner.organization.count({ where: { slug } })).toBe(1);
  });

  it('does not switch the caller into the organisation it just created', async () => {
    // Creation and switching are separate operations, and conflating them would
    // rotate a session as a side effect of a POST that says nothing about
    // sessions. The controller's own documentation says so; this is what holds
    // it true.
    const actor = await signedIn({});
    await request(server)
      .post('/api/v1/organizations')
      .set(csrf(actor))
      .send({ name: 'Not switched', slug: `notswitched-${unique()}` });

    const session = await owner.session.findUniqueOrThrow({
      where: { id: actor.sessionId },
      select: { activeOrganizationId: true, revokedAt: true },
    });
    expect(session.activeOrganizationId).toBeNull();
    expect(session.revokedAt).toBeNull();
  });

  it('refuses an unknown key with 400 UNKNOWN_FIELD', async () => {
    // Carry-forward ruling 14: `UNKNOWN_FIELD` at 400 when every Zod issue is
    // an unrecognised key. A validation failure hiding behind a different code
    // is what the ruling exists to prevent.
    const actor = await signedIn({});
    const response = await request(server)
      .post('/api/v1/organizations')
      .set(csrf(actor))
      .send({ name: 'Acme', slug: `unknown-${unique()}`, requireMfa: true });

    expect(response.status).toBe(400);
    expect(codeOf(response.body)).toBe('UNKNOWN_FIELD');
  });

  it('refuses a request with no CSRF header', async () => {
    const actor = await signedIn({});
    const response = await request(server)
      .post('/api/v1/organizations')
      .set('Cookie', actor.cookie)
      .send({ name: 'No CSRF', slug: `nocsrf-${unique()}` });

    expect(response.status).toBe(403);
    expect(codeOf(response.body)).toBe('CSRF_TOKEN_INVALID');
  });

  it('refuses an anonymous caller with 401', async () => {
    const response = await request(server)
      .post('/api/v1/organizations')
      .send({ name: 'Anonymous', slug: `anon-${unique()}` });
    expect(response.status).toBe(401);
  });
});

describe('GET /api/v1/organizations', () => {
  it('returns the caller’s organisations across tenants — ADR-0020 over sentinel_app', async () => {
    // The measurement the ADR turns on, driven through the real endpoint by the
    // real role. A `prisma.membership.findMany({ where: { userId } })` here
    // returns zero rows for this role, so this arm is red without the
    // SECURITY DEFINER function.
    const actor = await signedIn({});
    const first = await organizationFor({ userId: actor.userId });
    const second = await organizationFor({ userId: actor.userId });

    const response = await request(server).get('/api/v1/organizations').set('Cookie', actor.cookie);

    expect(response.status).toBe(200);
    const body = organizationCollectionSchema.parse(response.body);
    expect(body.data.map((row) => row.id).sort()).toEqual([first, second].sort());
  });

  it('refuses ?includeTotal=true with 400 UNKNOWN_FIELD rather than ignoring it', async () => {
    // `api/pagination.md` §3 documents `?includeTotal=true` as the opt-in for
    // `meta.total`, and this API does not implement it — no endpoint counts,
    // and the `reltuples` estimate above 100,000 rows does not exist. That
    // makes the interesting question what happens when a client trusts the
    // document, and the answer must be a refusal rather than a silently
    // ignored parameter: a caller who asks for a total and receives a page
    // without one, with a 200, has been told the total is genuinely absent
    // from the data.
    //
    // `listQuerySchema` is `.strict()`, so this is `UNKNOWN_FIELD` at 400 by
    // carry-forward ruling 14 — every Zod issue here is an unrecognised key.
    // Asserted rather than reasoned, because the documentation sentence added
    // to `pagination.md` in this change claims exactly this behaviour, and an
    // unverified claim about the repository is a false claim whether or not it
    // is meant.
    const actor = await signedIn({});

    const response = await request(server)
      .get('/api/v1/organizations?includeTotal=true')
      .set('Cookie', actor.cookie);

    expect(response.status).toBe(400);
    expect(codeOf(response.body)).toBe('UNKNOWN_FIELD');
  });

  it('does not return another user’s organisations', async () => {
    // The one failure mode ADR-0020 says its design cannot remove: a bug that
    // passes the wrong user id. The function's input has to be a user id for
    // the endpoint to exist, so this is the assertion that pins it.
    const mine = await signedIn({});
    const theirs = await signedIn({});
    const ours = await organizationFor({ userId: mine.userId });
    const notOurs = await organizationFor({ userId: theirs.userId });

    const response = await request(server).get('/api/v1/organizations').set('Cookie', mine.cookie);
    const ids = organizationCollectionSchema.parse(response.body).data.map((row) => row.id);
    expect(ids).toContain(ours);
    expect(ids).not.toContain(notOurs);
  });

  it('excludes a membership that was removed, with the live row arranged to come back last', async () => {
    // CARRY-FORWARD RULING 100: a regression test for a non-deterministic read
    // has to be ARRANGED TO LOSE. The removed rows are written FIRST, so
    // Postgres's physical order puts them ahead of the live one; a function body
    // that had dropped `deletedAt IS NULL` / `status = 'ACTIVE'` would return
    // them at the head of the result, where a test asserting only on the first
    // row would miss it. The assertion is on the whole set, which is stronger.
    const actor = await signedIn({});
    const removedFirst = await organizationFor({
      userId: actor.userId,
      membershipStatus: 'REMOVED',
    });
    const removedSecond = await organizationFor({
      userId: actor.userId,
      membershipStatus: 'REMOVED',
    });
    const live = await organizationFor({ userId: actor.userId });

    const response = await request(server).get('/api/v1/organizations').set('Cookie', actor.cookie);
    const ids = organizationCollectionSchema.parse(response.body).data.map((row) => row.id);
    expect(ids).toEqual([live]);
    expect(ids).not.toContain(removedFirst);
    expect(ids).not.toContain(removedSecond);
  });

  it('lists a suspended organisation, because membership is what it answers', async () => {
    // Deliberate. A member of a suspended organisation may do nothing in it —
    // `TenantContextGuard` refuses every guarded route with 403 — but hiding it
    // from the list would leave them with no way to see that it exists, and the
    // switcher in Task 17 needs to render it.
    const actor = await signedIn({});
    const suspended = await organizationFor({ userId: actor.userId, status: 'SUSPENDED' });
    const response = await request(server).get('/api/v1/organizations').set('Cookie', actor.cookie);
    const rows = organizationCollectionSchema.parse(response.body).data;
    expect(rows.map((row) => row.id)).toEqual([suspended]);
    expect(rows[0]?.status).toBe('SUSPENDED');
  });

  it('paginates by cursor, and the pages do not overlap or skip', async () => {
    const actor = await signedIn({});
    const ids = [
      await organizationFor({ userId: actor.userId }),
      await organizationFor({ userId: actor.userId }),
      await organizationFor({ userId: actor.userId }),
    ];

    const first = await request(server)
      .get('/api/v1/organizations?limit=2')
      .set('Cookie', actor.cookie);
    const page1 = organizationCollectionSchema.parse(first.body);
    expect(page1.data).toHaveLength(2);
    expect(page1.pagination.hasMore).toBe(true);
    expect(page1.pagination.nextCursor).not.toBeNull();

    const second = await request(server)
      .get(
        `/api/v1/organizations?limit=2&cursor=${encodeURIComponent(page1.pagination.nextCursor ?? '')}`,
      )
      .set('Cookie', actor.cookie);
    const page2 = organizationCollectionSchema.parse(second.body);
    expect(page2.data).toHaveLength(1);
    expect(page2.pagination.hasMore).toBe(false);
    expect(page2.pagination.nextCursor).toBeNull();

    // Every row exactly once. The id tie-breaker is what makes this hold when
    // two organisations share a `createdAt`, which for rows written in the same
    // millisecond is common rather than rare.
    const seen = [...page1.data, ...page2.data].map((row) => row.id);
    expect(seen.slice().sort()).toEqual(ids.slice().sort());
    expect(new Set(seen).size).toBe(3);
  });

  it('clamps a limit above the maximum and echoes the limit it applied', async () => {
    // `api/pagination.md` §4. The clamp and the echo are ONE feature: a client
    // that asked for 500, got 100 rows and was told nothing cannot tell that
    // apart from "100 is all there was", and stops paginating having seen a
    // fraction of what it asked for.
    const actor = await signedIn({});
    await organizationFor({ userId: actor.userId });

    const response = await request(server)
      .get('/api/v1/organizations?limit=500')
      .set('Cookie', actor.cookie);
    expect(response.status).toBe(200);
    expect(organizationCollectionSchema.parse(response.body).pagination.limit).toBe(100);
  });

  it('defaults the limit to 50 and echoes that', async () => {
    const actor = await signedIn({});
    await organizationFor({ userId: actor.userId });
    const response = await request(server).get('/api/v1/organizations').set('Cookie', actor.cookie);
    expect(organizationCollectionSchema.parse(response.body).pagination.limit).toBe(50);
  });

  it('refuses a cursor it did not issue with 400 rather than answering page one', async () => {
    const actor = await signedIn({});
    await organizationFor({ userId: actor.userId });
    const response = await request(server)
      .get('/api/v1/organizations?cursor=not-a-cursor')
      .set('Cookie', actor.cookie);
    expect(response.status).toBe(400);
    expect(codeOf(response.body)).toBe('VALIDATION_ERROR');
  });

  it('answers an empty page, not an error, for a user with no organisations', async () => {
    const actor = await signedIn({});
    const response = await request(server).get('/api/v1/organizations').set('Cookie', actor.cookie);
    const body = organizationCollectionSchema.parse(response.body);
    expect(body.data).toEqual([]);
    expect(body.pagination).toEqual({ nextCursor: null, hasMore: false, limit: 50 });
  });

  it('refuses an anonymous caller with 401', async () => {
    const response = await request(server).get('/api/v1/organizations');
    expect(response.status).toBe(401);
  });
});
