import type { Server } from 'node:http';
import {
  errorEnvelopeSchema,
  membershipCollectionSchema,
  membershipResponseSchema,
  roleCollectionSchema,
  ROLE_PERMISSIONS,
  type ErrorEnvelope,
  type SystemRole,
} from '@sentinel/contracts';
import { newId, seedReferenceData } from '@sentinel/db';
import type { PrismaClient } from '@sentinel/db/unscoped';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearRateLimits, startAuthHarness, type AuthHarness } from '../../testing/auth-harness.js';
import { CSRF_HEADER } from '../../common/guards/csrf.guard.js';
import { SESSION_COOKIE_NAME } from '../auth/cookies.js';
import { deriveCsrfToken } from '../auth/csrf-token.js';
import { mintSecretToken } from '../auth/secret-token.js';

/**
 * THE THREE MEMBERSHIP ROUTES AND `GET /api/v1/roles`, AGAINST REAL ROW-LEVEL
 * SECURITY, THE REAL GUARD CHAIN AND REAL SEEDED ROWS.
 *
 * # It connects as `sentinel_app`
 *
 * Carry-forward rulings 58 and 75, and the same choice
 * `organizations.integration.spec.ts` makes. The harness's default `PRISMA` is
 * the schema owner, a superuser that bypasses row-level security, so a suite
 * run under it would show that Postgres has policies rather than that this code
 * obeys them. Fixtures are seeded through the owner client, which is the one
 * thing the owner is right for.
 *
 * # What is deliberately NOT here
 *
 * The last-owner race and the lock that closes it live in
 * `last-owner.integration.spec.ts`, because they need connections this harness
 * does not hand out and because a concurrency proof that shares a file with
 * thirty CRUD assertions is a concurrency proof nobody reads.
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
  readonly token: string;
  readonly userId: string;
  readonly sessionId: string;
}

async function user(options: { emailVerified?: boolean } = {}): Promise<{ id: string }> {
  return owner.user.create({
    data: {
      id: newId('usr'),
      email: `members-${unique()}@example.test`,
      emailVerifiedAt: (options.emailVerified ?? true) ? new Date() : null,
      status: 'ACTIVE',
    },
    select: { id: true },
  });
}

async function sessionFor(userId: string, activeOrganizationId: string | null): Promise<Actor> {
  const minted = mintSecretToken();
  const now = Date.now();
  const session = await owner.session.create({
    data: {
      id: newId('ses'),
      userId,
      tokenHash: minted.tokenHash,
      activeOrganizationId,
      status: 'ACTIVE',
      idleExpiresAt: new Date(now + 24 * 60 * 60 * 1000),
      absoluteExpiresAt: new Date(now + 7 * 24 * 60 * 60 * 1000),
    },
    select: { id: true },
  });
  return {
    cookie: `${SESSION_COOKIE_NAME}=${minted.token}`,
    token: minted.token,
    userId,
    sessionId: session.id,
  };
}

async function organization(): Promise<string> {
  const suffix = unique();
  const created = await owner.organization.create({
    data: { id: newId('org'), slug: `members-${suffix}`, name: `Members ${suffix}` },
    select: { id: true },
  });
  return created.id;
}

async function membership(options: {
  organizationId: string;
  userId: string;
  role: SystemRole;
  status?: 'ACTIVE' | 'INVITED' | 'REMOVED';
}): Promise<string> {
  const role = await owner.role.findUniqueOrThrow({
    where: { key: options.role },
    select: { id: true },
  });
  const status = options.status ?? 'ACTIVE';
  const created = await owner.membership.create({
    data: {
      id: newId('mbr'),
      organizationId: options.organizationId,
      userId: options.userId,
      roleId: role.id,
      status,
      // Carry-forward ruling 10: the CHECK constraint
      // `Membership_status_deletedAt_agree_check` makes `REMOVED` and
      // soft-deleted one fact, so the two columns move together even in a
      // fixture.
      deletedAt: status === 'REMOVED' ? new Date() : null,
    },
    select: { id: true },
  });
  return created.id;
}

/**
 * One organisation with an actor already acting in it at the given role.
 *
 * `activeOrganizationId` is written directly rather than through
 * `POST /auth/switch-org`, for the reason `organizations.integration.spec.ts`
 * gives: using the endpoint would make every case here depend on another
 * endpoint's correctness.
 */
async function acting(role: SystemRole): Promise<{
  actor: Actor;
  organizationId: string;
  membershipId: string;
}> {
  const organizationId = await organization();
  const account = await user();
  const membershipId = await membership({ organizationId, userId: account.id, role });
  const actor = await sessionFor(account.id, organizationId);
  return { actor, organizationId, membershipId };
}

const csrf = (actor: Actor): Record<string, string> => ({
  Cookie: actor.cookie,
  [CSRF_HEADER]: deriveCsrfToken(actor.token),
});

const membersPath = (organizationId: string): string =>
  `/api/v1/organizations/${organizationId}/members`;

describe('GET /api/v1/organizations/:id/members', () => {
  it('lists the live memberships of the organisation the session is acting in', async () => {
    await clearRateLimits(harness.redis);
    const { actor, organizationId } = await acting('OWNER');
    const colleague = await user();
    await membership({ organizationId, userId: colleague.id, role: 'MEMBER' });

    const response = await request(server).get(membersPath(organizationId)).set(csrf(actor));

    expect(response.status).toBe(200);
    const body = membershipCollectionSchema.parse(response.body);
    expect(body.data).toHaveLength(2);
    expect(new Set(body.data.map((row) => row.roleKey))).toEqual(new Set(['OWNER', 'MEMBER']));
    expect(body.data.every((row) => row.organizationId === organizationId)).toBe(true);
    // The narrow user projection of `membershipUserSchema`: id, email, name and
    // nothing else. `lastLoginAt`, `failedLoginCount` and `lockedUntil` are the
    // account owner's business.
    for (const row of body.data) {
      expect(Object.keys(row.user).sort()).toEqual(['email', 'id', 'name']);
    }
  });

  it('does not list a removed member, and lists them again once re-added', async () => {
    await clearRateLimits(harness.redis);
    const { actor, organizationId } = await acting('OWNER');
    const colleague = await user();
    await membership({ organizationId, userId: colleague.id, role: 'MEMBER', status: 'REMOVED' });

    const removed = await request(server).get(membersPath(organizationId)).set(csrf(actor));
    expect(removed.status).toBe(200);
    expect(
      membershipCollectionSchema.parse(removed.body).data.map((row) => row.user.id),
    ).not.toContain(colleague.id);

    await membership({ organizationId, userId: colleague.id, role: 'VIEWER' });
    await clearRateLimits(harness.redis);
    const readded = await request(server).get(membersPath(organizationId)).set(csrf(actor));
    expect(readded.status).toBe(200);
    const rows = membershipCollectionSchema
      .parse(readded.body)
      .data.filter((row) => row.user.id === colleague.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.roleKey).toBe('VIEWER');
  });

  it('paginates, clamps the limit and echoes the limit it applied', async () => {
    await clearRateLimits(harness.redis);
    const { actor, organizationId } = await acting('OWNER');
    for (let i = 0; i < 3; i += 1) {
      const colleague = await user();
      await membership({ organizationId, userId: colleague.id, role: 'MEMBER' });
    }

    const first = await request(server)
      .get(`${membersPath(organizationId)}?limit=2`)
      .set(csrf(actor));
    expect(first.status).toBe(200);
    const firstPage = membershipCollectionSchema.parse(first.body);
    expect(firstPage.data).toHaveLength(2);
    expect(firstPage.pagination.hasMore).toBe(true);
    expect(firstPage.pagination.limit).toBe(2);
    expect(firstPage.pagination.nextCursor).not.toBeNull();

    await clearRateLimits(harness.redis);
    const second = await request(server)
      .get(
        `${membersPath(organizationId)}?limit=2&cursor=${encodeURIComponent(
          firstPage.pagination.nextCursor ?? '',
        )}`,
      )
      .set(csrf(actor));
    expect(second.status).toBe(200);
    const secondPage = membershipCollectionSchema.parse(second.body);
    expect(secondPage.data).toHaveLength(2);
    expect(secondPage.pagination.hasMore).toBe(false);
    // No row appears on both pages: the keyset cursor carries the tie-breaking
    // id, so rows sharing a `createdAt` are not skipped or repeated.
    const ids = [...firstPage.data, ...secondPage.data].map((row) => row.id);
    expect(new Set(ids).size).toBe(4);
  });

  it('refuses a malformed cursor with 400 rather than answering page one', async () => {
    await clearRateLimits(harness.redis);
    const { actor, organizationId } = await acting('OWNER');

    const response = await request(server)
      .get(`${membersPath(organizationId)}?cursor=not-a-cursor`)
      .set(csrf(actor));

    expect(response.status).toBe(400);
    expect(codeOf(response.body)).toBe('VALIDATION_ERROR');
  });

  it('answers 404 when the path names an organisation the session is not acting in', async () => {
    await clearRateLimits(harness.redis);
    const { actor } = await acting('OWNER');
    const elsewhere = await organization();

    const response = await request(server).get(membersPath(elsewhere)).set(csrf(actor));

    expect(response.status).toBe(404);
    expect(codeOf(response.body)).toBe('RESOURCE_NOT_FOUND');
  });

  it('refuses a role that lacks organization.manage_members with 403', async () => {
    await clearRateLimits(harness.redis);
    const { actor, organizationId } = await acting('VIEWER');

    const response = await request(server).get(membersPath(organizationId)).set(csrf(actor));

    expect(response.status).toBe(403);
    expect(codeOf(response.body)).toBe('PERMISSION_DENIED');
    expect(envelopeOf(response.body).error.details).toMatchObject({
      required: 'organization.manage_members',
      yourRole: 'VIEWER',
    });
  });
});

describe('PATCH /api/v1/organizations/:id/members/:membershipId', () => {
  it('changes the role, writes ROLE_CHANGED with before and after, and takes effect next request', async () => {
    await clearRateLimits(harness.redis);
    const { actor, organizationId } = await acting('OWNER');
    const colleague = await user();
    const target = await membership({ organizationId, userId: colleague.id, role: 'VIEWER' });
    const colleagueActor = await sessionFor(colleague.id, organizationId);

    const response = await request(server)
      .patch(`${membersPath(organizationId)}/${target}`)
      .set(csrf(actor))
      .send({ roleKey: 'ADMIN' });

    expect(response.status).toBe(200);
    expect(membershipResponseSchema.parse(response.body).roleKey).toBe('ADMIN');

    const events = await owner.auditEvent.findMany({
      where: { organizationId, action: 'ROLE_CHANGED' },
      select: { resourceType: true, resourceId: true, actorId: true, metadata: true },
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.resourceType).toBe('Membership');
    expect(events[0]?.resourceId).toBe(target);
    expect(events[0]?.actorId).toBe(actor.userId);
    expect(events[0]?.metadata).toMatchObject({ before: 'VIEWER', after: 'ADMIN' });

    // `product/permissions.md` invariant 4, over the promoted member's OWN
    // session cookie with no sign-in in between: a VIEWER could not have read
    // the member list a moment ago.
    await clearRateLimits(harness.redis);
    const nowAdmin = await request(server)
      .get(membersPath(organizationId))
      .set(csrf(colleagueActor));
    expect(nowAdmin.status).toBe(200);
  });

  it('refuses a role the actor does not themselves hold the permissions for, with 403', async () => {
    // D5, `security/authorization.md` §4: an ADMIN holds
    // `organization.manage_roles` but not `organization.delete`, so promoting
    // anybody to OWNER would mint authority the actor does not possess.
    await clearRateLimits(harness.redis);
    const { actor, organizationId } = await acting('ADMIN');
    const colleague = await user();
    const target = await membership({ organizationId, userId: colleague.id, role: 'MEMBER' });

    const response = await request(server)
      .patch(`${membersPath(organizationId)}/${target}`)
      .set(csrf(actor))
      .send({ roleKey: 'OWNER' });

    expect(response.status).toBe(403);
    expect(codeOf(response.body)).toBe('PERMISSION_DENIED');
    expect(envelopeOf(response.body).error.details).toMatchObject({
      required: 'organization.delete',
      yourRole: 'ADMIN',
    });

    const unchanged = await owner.membership.findUniqueOrThrow({
      where: { id: target },
      select: { role: { select: { key: true } } },
    });
    expect(unchanged.role.key).toBe('MEMBER');
  });

  it('admits a role change an ADMIN does have the permissions for', async () => {
    await clearRateLimits(harness.redis);
    const { actor, organizationId } = await acting('ADMIN');
    const colleague = await user();
    const target = await membership({ organizationId, userId: colleague.id, role: 'VIEWER' });

    const response = await request(server)
      .patch(`${membersPath(organizationId)}/${target}`)
      .set(csrf(actor))
      .send({ roleKey: 'MEMBER' });

    expect(response.status).toBe(200);
    expect(membershipResponseSchema.parse(response.body).roleKey).toBe('MEMBER');
  });

  it('refuses demoting the last OWNER with 422 and changes nothing', async () => {
    await clearRateLimits(harness.redis);
    const { actor, organizationId, membershipId } = await acting('OWNER');

    const response = await request(server)
      .patch(`${membersPath(organizationId)}/${membershipId}`)
      .set(csrf(actor))
      .send({ roleKey: 'ADMIN' });

    expect(response.status).toBe(422);
    expect(codeOf(response.body)).toBe('INVALID_STATE_TRANSITION');

    const unchanged = await owner.membership.findUniqueOrThrow({
      where: { id: membershipId },
      select: { role: { select: { key: true } } },
    });
    expect(unchanged.role.key).toBe('OWNER');
    expect(
      await owner.auditEvent.count({ where: { organizationId, action: 'ROLE_CHANGED' } }),
    ).toBe(0);
  });

  it('admits demoting one OWNER while a second OWNER remains', async () => {
    await clearRateLimits(harness.redis);
    const { actor, organizationId } = await acting('OWNER');
    const second = await user();
    const target = await membership({ organizationId, userId: second.id, role: 'OWNER' });

    const response = await request(server)
      .patch(`${membersPath(organizationId)}/${target}`)
      .set(csrf(actor))
      .send({ roleKey: 'ADMIN' });

    expect(response.status).toBe(200);
    expect(membershipResponseSchema.parse(response.body).roleKey).toBe('ADMIN');
  });

  it('does not count a REMOVED owner towards the invariant', async () => {
    // The trap ruling 99 describes, in the direction that matters here: a
    // soft-deleted OWNER row is not an owner, so an organisation holding one
    // live OWNER and one removed one still refuses the demotion.
    await clearRateLimits(harness.redis);
    const { actor, organizationId, membershipId } = await acting('OWNER');
    const departed = await user();
    await membership({ organizationId, userId: departed.id, role: 'OWNER', status: 'REMOVED' });

    const response = await request(server)
      .patch(`${membersPath(organizationId)}/${membershipId}`)
      .set(csrf(actor))
      .send({ roleKey: 'ADMIN' });

    expect(response.status).toBe(422);
    expect(codeOf(response.body)).toBe('INVALID_STATE_TRANSITION');
  });

  it('does not count an INVITED owner towards the invariant either', async () => {
    // The OTHER half of the count's predicate, and the one the CHECK constraint
    // does not imply. `Membership_status_deletedAt_agree_check` ties `REMOVED`
    // to soft-deleted, so `deletedAt: null` already excludes a removed row —
    // but `INVITED` is neither removed nor soft-deleted. Without `status:
    // 'ACTIVE'` in the owner count an organisation's only real owner could
    // demote themselves on the strength of an invitation nobody has accepted,
    // leaving nobody who can act.
    await clearRateLimits(harness.redis);
    const { actor, organizationId, membershipId } = await acting('OWNER');
    const invited = await user();
    await membership({ organizationId, userId: invited.id, role: 'OWNER', status: 'INVITED' });

    const response = await request(server)
      .patch(`${membersPath(organizationId)}/${membershipId}`)
      .set(csrf(actor))
      .send({ roleKey: 'ADMIN' });

    expect(response.status).toBe(422);
    expect(codeOf(response.body)).toBe('INVALID_STATE_TRANSITION');
  });

  it('answers 404 for a membership belonging to another tenant', async () => {
    await clearRateLimits(harness.redis);
    const { actor, organizationId } = await acting('OWNER');
    const elsewhere = await organization();
    const stranger = await user();
    const theirs = await membership({
      organizationId: elsewhere,
      userId: stranger.id,
      role: 'MEMBER',
    });

    const response = await request(server)
      .patch(`${membersPath(organizationId)}/${theirs}`)
      .set(csrf(actor))
      .send({ roleKey: 'ADMIN' });

    expect(response.status).toBe(404);
    expect(codeOf(response.body)).toBe('RESOURCE_NOT_FOUND');
  });

  it('answers 404 when the path names an organisation the session is not acting in', async () => {
    // `assertPathIsActiveTenant`, per route rather than only through the
    // authorization matrix. The membership id is a REAL, live one in the
    // caller's own organisation and the caller genuinely holds
    // `organization.manage_roles` there — so the only thing wrong with the
    // request is that `:id` names a different organisation. Without that check
    // the request would succeed, which is why the membership id has to be a
    // valid one: a made-up id answers 404 from the lookup and the arm would
    // pass over a handler that never compared the path to the tenant at all.
    await clearRateLimits(harness.redis);
    const { actor, organizationId } = await acting('OWNER');
    const colleague = await user();
    const target = await membership({ organizationId, userId: colleague.id, role: 'VIEWER' });
    const elsewhere = await organization();

    const response = await request(server)
      .patch(`${membersPath(elsewhere)}/${target}`)
      .set(csrf(actor))
      .send({ roleKey: 'ADMIN' });

    expect(response.status).toBe(404);
    expect(codeOf(response.body)).toBe('RESOURCE_NOT_FOUND');

    const unchanged = await owner.membership.findUniqueOrThrow({
      where: { id: target },
      select: { role: { select: { key: true } } },
    });
    expect(unchanged.role.key).toBe('VIEWER');
  });

  it('answers 404 for a membership id that does not exist, with the same body', async () => {
    await clearRateLimits(harness.redis);
    const { actor, organizationId } = await acting('OWNER');

    const response = await request(server)
      .patch(`${membersPath(organizationId)}/${newId('mbr')}`)
      .set(csrf(actor))
      .send({ roleKey: 'ADMIN' });

    expect(response.status).toBe(404);
    expect(codeOf(response.body)).toBe('RESOURCE_NOT_FOUND');
  });

  it('answers 404 for a membership that has already been removed', async () => {
    await clearRateLimits(harness.redis);
    const { actor, organizationId } = await acting('OWNER');
    const departed = await user();
    const target = await membership({
      organizationId,
      userId: departed.id,
      role: 'MEMBER',
      status: 'REMOVED',
    });

    const response = await request(server)
      .patch(`${membersPath(organizationId)}/${target}`)
      .set(csrf(actor))
      .send({ roleKey: 'ADMIN' });

    expect(response.status).toBe(404);
    expect(codeOf(response.body)).toBe('RESOURCE_NOT_FOUND');
  });

  it('refuses an unknown field with UNKNOWN_FIELD at 400', async () => {
    // Carry-forward ruling 14: `UNKNOWN_FIELD` only when EVERY Zod issue is an
    // unrecognised key. `updateMembershipRequestSchema` is `.strict()`.
    await clearRateLimits(harness.redis);
    const { actor, organizationId, membershipId } = await acting('OWNER');

    const response = await request(server)
      .patch(`${membersPath(organizationId)}/${membershipId}`)
      .set(csrf(actor))
      .send({ roleKey: 'ADMIN', status: 'REMOVED' });

    expect(response.status).toBe(400);
    expect(codeOf(response.body)).toBe('UNKNOWN_FIELD');
  });

  it('refuses a role that lacks organization.manage_roles with 403', async () => {
    await clearRateLimits(harness.redis);
    const { actor, organizationId } = await acting('SECURITY_LEAD');
    const colleague = await user();
    const target = await membership({ organizationId, userId: colleague.id, role: 'VIEWER' });

    const response = await request(server)
      .patch(`${membersPath(organizationId)}/${target}`)
      .set(csrf(actor))
      .send({ roleKey: 'MEMBER' });

    expect(response.status).toBe(403);
    expect(codeOf(response.body)).toBe('PERMISSION_DENIED');
    expect(envelopeOf(response.body).error.details).toMatchObject({
      required: 'organization.manage_roles',
    });
  });
});

describe('DELETE /api/v1/organizations/:id/members/:membershipId', () => {
  it('soft-deletes the membership, writing status and deletedAt together', async () => {
    await clearRateLimits(harness.redis);
    const { actor, organizationId } = await acting('OWNER');
    const colleague = await user();
    const target = await membership({ organizationId, userId: colleague.id, role: 'MEMBER' });

    const response = await request(server)
      .delete(`${membersPath(organizationId)}/${target}`)
      .set(csrf(actor));

    expect(response.status).toBe(204);

    // D3 and carry-forward ruling 10: the CHECK constraint would have refused
    // either column on its own, so a row that reads back like this is proof the
    // write set both.
    const row = await owner.membership.findUniqueOrThrow({
      where: { id: target },
      select: { status: true, deletedAt: true },
    });
    expect(row.status).toBe('REMOVED');
    expect(row.deletedAt).not.toBeNull();

    const events = await owner.auditEvent.findMany({
      where: { organizationId, action: 'MEMBER_REMOVED' },
      select: { resourceType: true, resourceId: true, actorId: true, metadata: true },
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.resourceType).toBe('Membership');
    expect(events[0]?.resourceId).toBe(target);
    expect(events[0]?.actorId).toBe(actor.userId);
    expect(events[0]?.metadata).toMatchObject({ before: 'MEMBER', after: null });
  });

  it('revokes the removed member’s sessions for that organisation IMMEDIATELY', async () => {
    // `product/permissions.md` invariant 5, and the word that matters is
    // "immediately": the assertion is on the member's very next request, with
    // no sign-in, no expiry and no cache TTL in between.
    await clearRateLimits(harness.redis);
    const { actor, organizationId } = await acting('OWNER');
    const colleague = await user();
    const target = await membership({ organizationId, userId: colleague.id, role: 'ADMIN' });
    const colleagueActor = await sessionFor(colleague.id, organizationId);

    // Their session works before the removal, over a permission-guarded route.
    await clearRateLimits(harness.redis);
    const before = await request(server).get(membersPath(organizationId)).set(csrf(colleagueActor));
    expect(before.status).toBe(200);

    await clearRateLimits(harness.redis);
    const removal = await request(server)
      .delete(`${membersPath(organizationId)}/${target}`)
      .set(csrf(actor));
    expect(removal.status).toBe(204);

    await clearRateLimits(harness.redis);
    const after = await request(server).get(membersPath(organizationId)).set(csrf(colleagueActor));
    expect(after.status).toBe(401);

    // `revokedAt`, NOT `status`. `enum SessionStatus` holds `PENDING_MFA` and
    // `ACTIVE` and has no `REVOKED` value at all: liveness is the `revokedAt`
    // timestamp and `status` records whether the MFA challenge was completed.
    // `SessionService.resolve` reads `row.revokedAt !== null` and nothing else.
    const session = await owner.session.findUniqueOrThrow({
      where: { id: colleagueActor.sessionId },
      select: { status: true, revokedAt: true },
    });
    expect(session.revokedAt).not.toBeNull();
    expect(session.status).toBe('ACTIVE');
  });

  it('does not brick the removed member: their other organisation and their account survive', async () => {
    // D4 and carry-forward ruling 95. A consultant removed from one
    // organisation must keep the sessions pointed at the others, and must still
    // be able to read their session document and sign out — the routes that are
    // `@AuthenticatedOnly()` rather than permission-guarded.
    await clearRateLimits(harness.redis);
    const { actor, organizationId } = await acting('OWNER');
    const colleague = await user();
    const target = await membership({ organizationId, userId: colleague.id, role: 'ADMIN' });

    const elsewhere = await organization();
    await membership({ organizationId: elsewhere, userId: colleague.id, role: 'ADMIN' });
    const sessionHere = await sessionFor(colleague.id, organizationId);
    const sessionThere = await sessionFor(colleague.id, elsewhere);
    const sessionNowhere = await sessionFor(colleague.id, null);

    await clearRateLimits(harness.redis);
    const removal = await request(server)
      .delete(`${membersPath(organizationId)}/${target}`)
      .set(csrf(actor));
    expect(removal.status).toBe(204);

    const rows = await owner.session.findMany({
      where: {
        id: { in: [sessionHere.sessionId, sessionThere.sessionId, sessionNowhere.sessionId] },
      },
      select: { id: true, revokedAt: true },
    });
    // Liveness is `revokedAt`, not `status` — see the note in the test above.
    const revokedById = new Map(rows.map((row) => [row.id, row.revokedAt]));
    expect(revokedById.get(sessionHere.sessionId)).not.toBeNull();
    expect(revokedById.get(sessionThere.sessionId)).toBeNull();
    expect(revokedById.get(sessionNowhere.sessionId)).toBeNull();

    // The other organisation still answers a guarded route for them.
    await clearRateLimits(harness.redis);
    const there = await request(server).get(membersPath(elsewhere)).set(csrf(sessionThere));
    expect(there.status).toBe(200);

    // And the session with no organisation can still read itself and sign out.
    await clearRateLimits(harness.redis);
    const document = await request(server)
      .get('/api/v1/auth/session')
      .set('Cookie', sessionNowhere.cookie);
    expect(document.status).toBe(200);

    await clearRateLimits(harness.redis);
    const loggedOut = await request(server)
      .post('/api/v1/auth/logout')
      .set(csrf(sessionNowhere))
      // `logoutRequestSchema` is `z.object({}).strict()` — an empty object, so
      // that a body with anything in it is rejected rather than ignored. Sending
      // no body at all is a 400 from the pipe, which is the endpoint working.
      .send({});
    expect(loggedOut.status).toBe(204);
  });

  it('refuses removing the last OWNER with 422 and changes nothing', async () => {
    await clearRateLimits(harness.redis);
    const { actor, organizationId, membershipId } = await acting('OWNER');

    const response = await request(server)
      .delete(`${membersPath(organizationId)}/${membershipId}`)
      .set(csrf(actor));

    expect(response.status).toBe(422);
    expect(codeOf(response.body)).toBe('INVALID_STATE_TRANSITION');

    const row = await owner.membership.findUniqueOrThrow({
      where: { id: membershipId },
      select: { status: true, deletedAt: true },
    });
    expect(row.status).toBe('ACTIVE');
    expect(row.deletedAt).toBeNull();
    expect(
      await owner.auditEvent.count({ where: { organizationId, action: 'MEMBER_REMOVED' } }),
    ).toBe(0);
  });

  it('admits removing one OWNER while a second OWNER remains', async () => {
    await clearRateLimits(harness.redis);
    const { actor, organizationId } = await acting('OWNER');
    const second = await user();
    const target = await membership({ organizationId, userId: second.id, role: 'OWNER' });

    const response = await request(server)
      .delete(`${membersPath(organizationId)}/${target}`)
      .set(csrf(actor));

    expect(response.status).toBe(204);
  });

  it('refuses an ADMIN removing an OWNER with 403, and the OWNER is still there', async () => {
    // THE ASYMMETRY THIS CLOSES. D5 stops an `ADMIN` from *making* an `OWNER`;
    // without the mirror on this route an `ADMIN` could *unmake* one and could
    // not undo it — the removed owner cannot restore themselves and no `ADMIN`
    // can promote a replacement. `security/authorization.md` §4: you cannot mint
    // authority you do not possess, and evicting the only principal who holds it
    // is the same rule pointed the other way.
    await clearRateLimits(harness.redis);
    const { actor, organizationId } = await acting('ADMIN');
    const boss = await user();
    const target = await membership({ organizationId, userId: boss.id, role: 'OWNER' });

    const response = await request(server)
      .delete(`${membersPath(organizationId)}/${target}`)
      .set(csrf(actor));

    expect(response.status).toBe(403);
    expect(codeOf(response.body)).toBe('PERMISSION_DENIED');
    // The same `required` the PATCH arm names, from the same helper: the first
    // permission in `PERMISSIONS` order that OWNER holds and ADMIN does not.
    expect(envelopeOf(response.body).error.details).toMatchObject({
      required: 'organization.delete',
      yourRole: 'ADMIN',
    });

    // A 403 that left the row removed would be the worst of both answers.
    const row = await owner.membership.findUniqueOrThrow({
      where: { id: target },
      select: { status: true, deletedAt: true },
    });
    expect(row.status).toBe('ACTIVE');
    expect(row.deletedAt).toBeNull();
    expect(
      await owner.auditEvent.count({ where: { organizationId, action: 'MEMBER_REMOVED' } }),
    ).toBe(0);
  });

  it('admits an ADMIN removing another ADMIN — equal sets pass', async () => {
    // The rule must not brick the ordinary case. `ADMIN` removing `ADMIN` is a
    // set compared with itself, so nothing is missing and it passes. This arm is
    // what stops the check above from being satisfied by a role *ranking*, which
    // would refuse this one too.
    await clearRateLimits(harness.redis);
    const { actor, organizationId } = await acting('ADMIN');
    const colleague = await user();
    const target = await membership({ organizationId, userId: colleague.id, role: 'ADMIN' });

    const response = await request(server)
      .delete(`${membersPath(organizationId)}/${target}`)
      .set(csrf(actor));

    expect(response.status).toBe(204);
  });

  it('admits an ADMIN removing themselves, and revokes their session for this organisation', async () => {
    // SELF-REMOVAL IS SUPPORTED, and the authority check never refuses it: an
    // actor's own role is an equal set to itself. Leaving an organisation is a
    // legitimate action, bounded by the last-owner invariant, and ruling 95 is
    // satisfied — the account survives, only this tenant's sessions go.
    await clearRateLimits(harness.redis);
    const { actor, organizationId, membershipId } = await acting('ADMIN');
    // A second member holding OWNER, so the last-owner invariant is not what
    // decides this arm.
    const boss = await user();
    await membership({ organizationId, userId: boss.id, role: 'OWNER' });

    const response = await request(server)
      .delete(`${membersPath(organizationId)}/${membershipId}`)
      .set(csrf(actor));

    expect(response.status).toBe(204);

    const row = await owner.membership.findUniqueOrThrow({
      where: { id: membershipId },
      select: { status: true, deletedAt: true },
    });
    expect(row.status).toBe('REMOVED');
    expect(row.deletedAt).not.toBeNull();

    const session = await owner.session.findUniqueOrThrow({
      where: { id: actor.sessionId },
      select: { revokedAt: true },
    });
    expect(session.revokedAt).not.toBeNull();
  });

  it('admits an OWNER removing an OWNER — the rule refuses reaching upwards, not sideways', async () => {
    await clearRateLimits(harness.redis);
    const { actor, organizationId } = await acting('OWNER');
    const peer = await user();
    const target = await membership({ organizationId, userId: peer.id, role: 'OWNER' });

    const response = await request(server)
      .delete(`${membersPath(organizationId)}/${target}`)
      .set(csrf(actor));

    expect(response.status).toBe(204);
  });

  it('completes the add / remove / re-add round trip, and the resolver keeps using the LIVE row', async () => {
    // Carry-forward rulings 99 and 100, arranged to lose. Remove-then-re-add
    // puts the live row PHYSICALLY LAST, which is the arrangement in which an
    // unordered `findFirst` with no `deletedAt` predicate returns a REMOVED row
    // — a silent, non-deterministic 404 on every guarded route for a member who
    // is active. Inserting the removed rows first would let the live row come
    // back by luck and the test would pass under the mutation.
    await clearRateLimits(harness.redis);
    const { actor, organizationId } = await acting('OWNER');
    const colleague = await user();

    // Two remove/re-add cycles, so the pair ends with two REMOVED rows written
    // before the live one.
    for (let cycle = 0; cycle < 2; cycle += 1) {
      const target = await membership({ organizationId, userId: colleague.id, role: 'ADMIN' });
      await clearRateLimits(harness.redis);
      const removal = await request(server)
        .delete(`${membersPath(organizationId)}/${target}`)
        .set(csrf(actor));
      expect(removal.status).toBe(204);
    }
    const live = await membership({ organizationId, userId: colleague.id, role: 'ADMIN' });

    const rows = await owner.membership.findMany({
      where: { organizationId, userId: colleague.id },
      select: { id: true, status: true },
    });
    expect(rows).toHaveLength(3);
    expect(rows.filter((row) => row.status === 'REMOVED')).toHaveLength(2);

    // The resolver — `TenantContextGuard`'s query, reached through a real
    // guarded request — must find the LIVE row, not one of the two removed ones
    // that were written before it.
    const colleagueActor = await sessionFor(colleague.id, organizationId);
    await clearRateLimits(harness.redis);
    const response = await request(server)
      .get(membersPath(organizationId))
      .set(csrf(colleagueActor));
    expect(response.status).toBe(200);

    // And the member list shows exactly one row for them: the live one.
    const listed = membershipCollectionSchema
      .parse(response.body)
      .data.filter((row) => row.user.id === colleague.id);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(live);
  });

  it('answers 404 when the path names an organisation the session is not acting in', async () => {
    // The removal's half of `assertPathIsActiveTenant` — a real, live
    // membership in the caller's own organisation, reached through a path that
    // names a different one. See the PATCH test above for why the id must be a
    // real one.
    await clearRateLimits(harness.redis);
    const { actor, organizationId } = await acting('OWNER');
    const colleague = await user();
    const target = await membership({ organizationId, userId: colleague.id, role: 'VIEWER' });
    const elsewhere = await organization();

    const response = await request(server)
      .delete(`${membersPath(elsewhere)}/${target}`)
      .set(csrf(actor));

    expect(response.status).toBe(404);
    expect(codeOf(response.body)).toBe('RESOURCE_NOT_FOUND');

    const untouched = await owner.membership.findUniqueOrThrow({
      where: { id: target },
      select: { status: true, deletedAt: true },
    });
    expect(untouched.status).toBe('ACTIVE');
    expect(untouched.deletedAt).toBeNull();
  });

  it('answers 404 for another tenant’s membership id', async () => {
    await clearRateLimits(harness.redis);
    const { actor, organizationId } = await acting('OWNER');
    const elsewhere = await organization();
    const stranger = await user();
    const theirs = await membership({
      organizationId: elsewhere,
      userId: stranger.id,
      role: 'MEMBER',
    });

    const response = await request(server)
      .delete(`${membersPath(organizationId)}/${theirs}`)
      .set(csrf(actor));

    expect(response.status).toBe(404);
    expect(codeOf(response.body)).toBe('RESOURCE_NOT_FOUND');

    const untouched = await owner.membership.findUniqueOrThrow({
      where: { id: theirs },
      select: { status: true, deletedAt: true },
    });
    expect(untouched.status).toBe('ACTIVE');
    expect(untouched.deletedAt).toBeNull();
  });

  it('refuses a role that lacks organization.manage_members with 403', async () => {
    await clearRateLimits(harness.redis);
    const { actor, organizationId } = await acting('SECURITY_LEAD');
    const colleague = await user();
    const target = await membership({ organizationId, userId: colleague.id, role: 'VIEWER' });

    const response = await request(server)
      .delete(`${membersPath(organizationId)}/${target}`)
      .set(csrf(actor));

    expect(response.status).toBe(403);
    expect(codeOf(response.body)).toBe('PERMISSION_DENIED');
  });
});

describe('GET /api/v1/roles', () => {
  it('returns every seeded system role with the permissions the seeded rows grant', async () => {
    await clearRateLimits(harness.redis);
    const { actor } = await acting('VIEWER');

    const response = await request(server).get('/api/v1/roles').set(csrf(actor));

    expect(response.status).toBe(200);
    const body = roleCollectionSchema.parse(response.body);
    expect(body.data).toHaveLength(7);
    for (const role of body.data) {
      expect(role.isSystem).toBe(true);
      // Read from the seeded `RolePermission` rows, and they must expand to
      // exactly `ROLE_PERMISSIONS` — the same equality
      // `authorization.integration.spec.ts` asserts, re-checked here because
      // this endpoint is what a client renders a role picker from.
      expect([...role.permissions].sort()).toEqual([...ROLE_PERMISSIONS[role.key]].sort());
    }
  });

  it('refuses an unauthenticated caller with 401', async () => {
    await clearRateLimits(harness.redis);
    const response = await request(server).get('/api/v1/roles');
    expect(response.status).toBe(401);
  });

  it('answers 404 to a session that is acting in no organisation', async () => {
    // It declares `organization.read`, so it is read INSIDE an organisation.
    // A session naming no organisation resolves no tenant and
    // `AuthorizationGuard` fails closed as 404 rather than 403.
    await clearRateLimits(harness.redis);
    const account = await user();
    const actor = await sessionFor(account.id, null);

    const response = await request(server).get('/api/v1/roles').set(csrf(actor));

    expect(response.status).toBe(404);
    expect(codeOf(response.body)).toBe('RESOURCE_NOT_FOUND');
  });
});
