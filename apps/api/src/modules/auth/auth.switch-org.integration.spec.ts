import type { Server } from 'node:http';
import {
  errorEnvelopeSchema,
  ROLE_PERMISSIONS,
  sessionResponseSchema,
  type ErrorEnvelope,
  type SystemRole,
} from '@sentinel/contracts';
import { newId, seedReferenceData } from '@sentinel/db';
import type { PrismaClient } from '@sentinel/db/unscoped';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CSRF_HEADER } from '../../common/guards/csrf.guard.js';
import { startAuthHarness, type AuthHarness } from '../../testing/auth-harness.js';
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from './cookies.js';
import { deriveCsrfToken } from './csrf-token.js';
import { mintSecretToken } from './secret-token.js';

/**
 * `POST /api/v1/auth/switch-org` — THE ROUTE THAT WRITES
 * `Session.activeOrganizationId`, AND THEREFORE THE ROUTE THAT MAKES EVERY
 * CONTROL TASK 12 BUILT START RUNNING.
 *
 * Carry-forward ruling 93: that column is the only source of the active
 * organisation and nothing wrote it before this task, so `TenantContextGuard`
 * short-circuited on every request, `MfaEnrolmentGuard` exited early, and
 * `GET /auth/session` returned `permissions: []` — the same value it returned
 * before, for a different reason.
 *
 * **The ruling also fixes what counts as evidence here, and it is the reason
 * for the assertion this file is built around.** An empty permission set proves
 * nothing, because it is exactly what an unresolved tenant produces. So the
 * central test asserts a **populated** `permissions` array, compared against
 * `ROLE_PERMISSIONS` for the role the member actually holds — a value that
 * cannot be produced without a resolved membership, a resolved organisation and
 * the seeded grant rows.
 *
 * It connects as `sentinel_app` (ruling 75), so the resolver's tenant
 * transaction is load-bearing rather than incidental.
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

async function signedIn(activeOrganizationId: string | null = null): Promise<Actor> {
  const suffix = unique();
  const user = await owner.user.create({
    data: {
      id: newId('usr'),
      email: `switch-${suffix}@example.test`,
      emailVerifiedAt: new Date(),
      status: 'ACTIVE',
    },
    select: { id: true },
  });
  const minted = mintSecretToken();
  const now = Date.now();
  const session = await owner.session.create({
    data: {
      id: newId('ses'),
      userId: user.id,
      tokenHash: minted.tokenHash,
      activeOrganizationId,
      status: 'ACTIVE',
      idleExpiresAt: new Date(now + 86_400_000),
      absoluteExpiresAt: new Date(now + 7 * 86_400_000),
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

async function organizationFor(options: {
  userId: string;
  role?: SystemRole;
  status?: 'ACTIVE' | 'SUSPENDED';
  membershipStatus?: 'ACTIVE' | 'INVITED' | 'REMOVED';
}): Promise<string> {
  const suffix = unique();
  const organization = await owner.organization.create({
    data: {
      id: newId('org'),
      slug: `switch-${suffix}`,
      name: `Switch ${suffix}`,
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
      // Ruling 10: the CHECK constraint makes `REMOVED` and soft-deleted the
      // same fact, so the two move together or the write is refused.
      deletedAt: membershipStatus === 'REMOVED' ? new Date() : null,
    },
    select: { id: true },
  });
  return organization.id;
}

const switchTo = (actor: Actor, organizationId: string): request.Test =>
  request(server)
    .post('/api/v1/auth/switch-org')
    .set({
      Cookie: actor.cookie,
      // Derived from the raw session token, which is what `CsrfGuard` compares
      // against — not the CSRF cookie. See `csrf.guard.ts`.
      [CSRF_HEADER]: deriveCsrfToken(actor.token),
    })
    .send({ organizationId });

describe('POST /api/v1/auth/switch-org', () => {
  it('returns a POPULATED permission set — the first non-empty one in this phase', async () => {
    // THE ASSERTION THIS FILE EXISTS FOR (ruling 93). A `permissions` array
    // equal to `ROLE_PERMISSIONS.SECURITY_LEAD` cannot be produced by an
    // unresolved tenant, by a short-circuiting guard, or by a stub: it requires
    // the membership row, the organisation row, the seeded `Role` and the
    // seeded `RolePermission` grants, all read inside a tenant transaction over
    // `sentinel_app`.
    //
    // `SECURITY_LEAD` rather than `OWNER` deliberately — `OWNER` holds every
    // permission, so an implementation that returned the whole catalogue
    // regardless of role would pass. This role holds a proper subset.
    const actor = await signedIn();
    const organizationId = await organizationFor({
      userId: actor.userId,
      role: 'SECURITY_LEAD',
    });

    const response = await switchTo(actor, organizationId);

    expect(response.status).toBe(200);
    const document = sessionResponseSchema.parse(response.body);
    expect(document.permissions.length).toBeGreaterThan(0);
    expect(document.permissions).toEqual([...ROLE_PERMISSIONS.SECURITY_LEAD].sort());
    expect(document.permissions.length).toBeLessThan(ROLE_PERMISSIONS.OWNER.length);
    expect(document.activeOrganization?.id).toBe(organizationId);
    expect(document.userId).toBe(actor.userId);
  });

  it('rotates the session: the old token stops working and a new one is set', async () => {
    // `security/authentication.md` §3, "rotate on privilege change". Switching
    // organisation changes the effective permission set of the credential in
    // the browser, so the token that existed before the change must not work
    // after it — which is what stops an attacker who planted a session value
    // from riding the victim's escalation.
    const actor = await signedIn();
    const organizationId = await organizationFor({ userId: actor.userId });

    const response = await switchTo(actor, organizationId);
    expect(response.status).toBe(200);

    const setCookie = response.get('Set-Cookie') ?? [];
    expect(setCookie.some((value) => value.startsWith(`${SESSION_COOKIE_NAME}=`))).toBe(true);
    // Both cookies, because the CSRF token derives from the session token —
    // sending one without the other leaves the browser holding a pair that
    // cannot validate.
    expect(setCookie.some((value) => value.startsWith(`${CSRF_COOKIE_NAME}=`))).toBe(true);

    // The predecessor row is revoked, not merely superseded.
    const predecessor = await owner.session.findUniqueOrThrow({
      where: { id: actor.sessionId },
      select: { revokedAt: true },
    });
    expect(predecessor.revokedAt).not.toBeNull();

    // And the old credential is refused immediately — the cache entry is
    // tombstoned before the row is written, so there is no window in which it
    // still resolves.
    const replay = await request(server).get('/api/v1/auth/session').set('Cookie', actor.cookie);
    expect(replay.status).toBe(401);
  });

  it('writes activeOrganizationId onto the successor session, not the predecessor', async () => {
    const actor = await signedIn();
    const organizationId = await organizationFor({ userId: actor.userId });
    await switchTo(actor, organizationId).expect(200);

    const predecessor = await owner.session.findUniqueOrThrow({
      where: { id: actor.sessionId },
      select: { activeOrganizationId: true },
    });
    expect(predecessor.activeOrganizationId).toBeNull();

    const successor = await owner.session.findFirstOrThrow({
      where: { userId: actor.userId, rotatedFromId: actor.sessionId },
      select: { activeOrganizationId: true, revokedAt: true, status: true },
    });
    expect(successor.activeOrganizationId).toBe(organizationId);
    expect(successor.revokedAt).toBeNull();
    expect(successor.status).toBe('ACTIVE');
  });

  it('writes ORGANIZATION_SWITCHED into the organisation switched TO', async () => {
    const actor = await signedIn();
    const organizationId = await organizationFor({ userId: actor.userId, role: 'ADMIN' });
    await switchTo(actor, organizationId).expect(200);

    const events = await owner.auditEvent.findMany({
      where: { organizationId, action: 'ORGANIZATION_SWITCHED' },
      select: {
        actorType: true,
        actorId: true,
        resourceType: true,
        resourceId: true,
        metadata: true,
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorType: 'USER',
      actorId: actor.userId,
      resourceType: 'Organization',
      resourceId: organizationId,
    });
    // `roleKey` records what the member switched in AS, which is the fact a
    // later role change makes impossible to reconstruct from current state.
    expect(events[0]?.metadata).toMatchObject({ roleKey: 'ADMIN' });
  });

  it('makes the guarded organisation routes answer for the first time', async () => {
    // THE END-TO-END POINT OF THE TASK. Before the switch this caller has no
    // active organisation, so `TenantContextGuard` refuses every
    // permission-guarded route with 404. After it, the same route answers 200 —
    // which means tenant resolution, the organisation-status check, the
    // MFA-enrolment gate and the permission check all executed on a real
    // request and all admitted it.
    const actor = await signedIn();
    const organizationId = await organizationFor({ userId: actor.userId });

    const before = await request(server)
      .get(`/api/v1/organizations/${organizationId}`)
      .set('Cookie', actor.cookie);
    expect(before.status).toBe(404);

    const switched = await switchTo(actor, organizationId).expect(200);
    const cookie = (switched.get('Set-Cookie') ?? []).find((value) =>
      value.startsWith(`${SESSION_COOKIE_NAME}=`),
    );
    expect(cookie).toBeDefined();

    const after = await request(server)
      .get(`/api/v1/organizations/${organizationId}`)
      .set('Cookie', (cookie ?? '').split(';')[0] ?? '');
    expect(after.status).toBe(200);
  });

  it('answers 404 for an organisation the caller does not belong to', async () => {
    // Cross-tenant isolation on this route. 404, never 403 — a 403 would
    // confirm the organisation exists.
    const actor = await signedIn();
    const stranger = await signedIn();
    const theirs = await organizationFor({ userId: stranger.userId });

    const response = await switchTo(actor, theirs);
    expect(response.status).toBe(404);
    expect(codeOf(response.body)).toBe('RESOURCE_NOT_FOUND');
  });

  it('answers 404, byte-identical, for an organisation that does not exist', async () => {
    // The two must be indistinguishable, or the endpoint is an existence
    // oracle for organisation ids. Compared by body with `requestId` substituted
    // out — carry-forward ruling 77, because that field varies by design.
    const actor = await signedIn();
    const stranger = await signedIn();
    const theirs = await organizationFor({ userId: stranger.userId });
    const strip = (body: unknown): unknown =>
      JSON.parse(JSON.stringify(body).replace(/"requestId":"[^"]*"/, '"requestId":"<id>"'));

    const missing = await switchTo(actor, newId('org'));
    const notMine = await switchTo(actor, theirs);

    expect(missing.status).toBe(404);
    expect(strip(missing.body)).toEqual(strip(notMine.body));
  });

  it('answers 404 for a membership that was REMOVED', async () => {
    // Ruling 99's shape at the endpoint. A removed member is not a member, and
    // the resolver's `deletedAt: null` predicate is what makes that answer
    // deterministic when a re-added member has several rows.
    const actor = await signedIn();
    const organizationId = await organizationFor({
      userId: actor.userId,
      membershipStatus: 'REMOVED',
    });
    const response = await switchTo(actor, organizationId);
    expect(response.status).toBe(404);
  });

  it('answers 404 for a membership that is only INVITED', async () => {
    // `security/authorization.md` §2 layer 2 asks two questions — does the
    // principal belong to this organisation, AND is the membership active. An
    // invitation that has not been accepted is exactly the case where the row
    // exists and the answer is no.
    const actor = await signedIn();
    const organizationId = await organizationFor({
      userId: actor.userId,
      membershipStatus: 'INVITED',
    });
    const response = await switchTo(actor, organizationId);
    expect(response.status).toBe(404);
  });

  it('answers 403 ORGANIZATION_SUSPENDED for a suspended organisation the caller belongs to', async () => {
    // Not 404: the caller is a member, so the suspension is not somebody else's
    // secret. The code and status match what `TenantContextGuard` answers on
    // every guarded route afterwards, so a member cannot switch in successfully
    // and then be refused everywhere with a different explanation.
    const actor = await signedIn();
    const organizationId = await organizationFor({ userId: actor.userId, status: 'SUSPENDED' });

    const response = await switchTo(actor, organizationId);
    expect(response.status).toBe(403);
    expect(codeOf(response.body)).toBe('ORGANIZATION_SUSPENDED');
  });

  it('leaves the session untouched when it refuses', async () => {
    // A refusal must not rotate. Otherwise a caller could be signed out by
    // guessing organisation ids, and an attacker who could reach this endpoint
    // would have a session-destruction primitive.
    const actor = await signedIn();
    await switchTo(actor, newId('org')).expect(404);

    const session = await owner.session.findUniqueOrThrow({
      where: { id: actor.sessionId },
      select: { revokedAt: true, activeOrganizationId: true },
    });
    expect(session.revokedAt).toBeNull();
    expect(session.activeOrganizationId).toBeNull();

    // Still usable.
    await request(server).get('/api/v1/auth/session').set('Cookie', actor.cookie).expect(200);
  });

  it('refuses a request with no CSRF header', async () => {
    const actor = await signedIn();
    const organizationId = await organizationFor({ userId: actor.userId });
    const response = await request(server)
      .post('/api/v1/auth/switch-org')
      .set('Cookie', actor.cookie)
      .send({ organizationId });

    expect(response.status).toBe(403);
    expect(codeOf(response.body)).toBe('CSRF_TOKEN_INVALID');
  });

  it('refuses an unknown key with 400 UNKNOWN_FIELD', async () => {
    // Ruling 14: every issue is an unrecognised key, so the code is
    // `UNKNOWN_FIELD` rather than `VALIDATION_ERROR`.
    const actor = await signedIn();
    const organizationId = await organizationFor({ userId: actor.userId });
    const response = await request(server)
      .post('/api/v1/auth/switch-org')
      .set({ Cookie: actor.cookie, [CSRF_HEADER]: deriveCsrfToken(actor.token) })
      .send({ organizationId, rememberMe: true });

    expect(response.status).toBe(400);
    expect(codeOf(response.body)).toBe('UNKNOWN_FIELD');
  });

  it('refuses an anonymous caller with 401', async () => {
    const response = await request(server)
      .post('/api/v1/auth/switch-org')
      .send({ organizationId: newId('org') });
    expect(response.status).toBe(401);
  });
});
