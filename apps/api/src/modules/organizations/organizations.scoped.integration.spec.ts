import type { Server } from 'node:http';
import {
  errorEnvelopeSchema,
  organizationResponseSchema,
  type ErrorEnvelope,
  type SystemRole,
} from '@sentinel/contracts';
import { newId, seedReferenceData } from '@sentinel/db';
import type { PrismaClient } from '@sentinel/db/unscoped';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CSRF_HEADER } from '../../common/guards/csrf.guard.js';
import { startAuthHarness, type AuthHarness } from '../../testing/auth-harness.js';
import { SESSION_COOKIE_NAME } from '../auth/cookies.js';
import { deriveCsrfToken } from '../auth/csrf-token.js';
import { mintSecretToken } from '../auth/secret-token.js';

/**
 * `GET`, `PATCH` AND `DELETE` ON `/organizations/:id` — THE FIRST SHIPPED
 * ROUTES IN THIS PRODUCT THAT DECLARE A PERMISSION.
 *
 * # What is new here, stated precisely
 *
 * Task 12 built nine global guards and six ordered layers and **not one of them
 * had ever refused a caller on a production endpoint** (carry-forward ruling
 * 93): `TenantContextGuard` short-circuits while `Session.activeOrganizationId`
 * is NULL, and no shipped route declared a permission for the denial arms to
 * fire on. Every 403 and every cross-tenant 404 below is one of those layers
 * running for real.
 *
 * **Ruling 93 also says what does not count as evidence.** An empty permission
 * set is what an unresolved tenant produces, so it can never show that
 * resolution ran. Nothing below asserts an empty anything: the arms assert a
 * 200 with a body, a 403 naming a permission, or a 404 where a 200 would
 * otherwise be — each of which is only reachable through a resolved tenant, or
 * only reachable through a deliberate refusal.
 *
 * # Cross-tenant isolation is mandatory, and it is 404 rather than 403
 *
 * `CLAUDE.md`'s testing rule, and `security/authorization.md` §6's reason: a
 * 403 confirms the resource exists. Three cases must be indistinguishable —
 * an id that never existed, an id belonging to another tenant, and an id
 * belonging to an organisation the caller *is* a member of but is not currently
 * acting in. The last is the one a reviewer should look hardest at, because it
 * is the one a "helpful" implementation gets wrong.
 *
 * # It connects as `sentinel_app`
 *
 * Ruling 75. Under the schema owner every policy is bypassed and this file
 * would be asserting that Nest has guards rather than that the database
 * enforces anything.
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

interface Member {
  readonly cookie: string;
  readonly token: string;
  readonly userId: string;
  readonly organizationId: string;
}

/**
 * A user with a membership at the given role and a session already acting in
 * that organisation.
 *
 * The active organisation is written through the owner client rather than
 * through `POST /auth/switch-org`, so this suite does not depend on that
 * endpoint being correct — it has its own.
 */
async function member(options: {
  role?: SystemRole;
  organizationStatus?: 'ACTIVE' | 'SUSPENDED';
  /** Point the session somewhere other than the organisation just created. */
  activeOrganizationId?: string;
}): Promise<Member> {
  const suffix = unique();
  const organization = await owner.organization.create({
    data: {
      id: newId('org'),
      slug: `scoped-${suffix}`,
      name: `Scoped ${suffix}`,
      status: options.organizationStatus ?? 'ACTIVE',
    },
    select: { id: true },
  });
  const user = await owner.user.create({
    data: {
      id: newId('usr'),
      email: `scoped-${suffix}@example.test`,
      emailVerifiedAt: new Date(),
      status: 'ACTIVE',
    },
    select: { id: true },
  });
  const role = await owner.role.findUniqueOrThrow({
    where: { key: options.role ?? 'OWNER' },
    select: { id: true },
  });
  await owner.membership.create({
    data: {
      id: newId('mbr'),
      organizationId: organization.id,
      userId: user.id,
      roleId: role.id,
      status: 'ACTIVE',
      // Ruling 10: `status` and `deletedAt` move together or the CHECK
      // constraint refuses the write.
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
      activeOrganizationId: options.activeOrganizationId ?? organization.id,
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
  };
}

const csrf = (actor: Member): Record<string, string> => ({
  Cookie: actor.cookie,
  [CSRF_HEADER]: deriveCsrfToken(actor.token),
});

/** An organisation with an audit event, so `DELETE` meets the real constraint. */
async function withAuditHistory(organizationId: string, actorId: string): Promise<void> {
  await owner.auditEvent.create({
    data: {
      id: newId('aud'),
      organizationId,
      actorType: 'USER',
      actorId,
      action: 'ORGANIZATION_CREATED',
      resourceType: 'Organization',
      resourceId: organizationId,
      metadata: {},
    },
    select: { id: true },
  });
}

describe('GET /api/v1/organizations/:id', () => {
  it('returns the organisation the session is acting in', async () => {
    const actor = await member({});
    const response = await request(server)
      .get(`/api/v1/organizations/${actor.organizationId}`)
      .set('Cookie', actor.cookie);

    expect(response.status).toBe(200);
    // A populated body, not an empty set — ruling 93's standard of evidence.
    // This response could only come from a resolved tenant: `TenantContextGuard`
    // answers 404 without one, and the read itself runs inside a tenant
    // transaction that returns zero rows for `sentinel_app` unless
    // `app.organization_id` was set.
    expect(organizationResponseSchema.parse(response.body).id).toBe(actor.organizationId);
  });

  it('answers 404 for another tenant’s organisation', async () => {
    // MANDATORY CROSS-TENANT ISOLATION. Tenant A receives 404 for Tenant B's id.
    const a = await member({});
    const b = await member({});
    const response = await request(server)
      .get(`/api/v1/organizations/${b.organizationId}`)
      .set('Cookie', a.cookie);

    expect(response.status).toBe(404);
    expect(codeOf(response.body)).toBe('RESOURCE_NOT_FOUND');
  });

  it('answers 404 for an organisation the caller belongs to but is not acting in', async () => {
    // D4's surprising case, and the deliberate one. The path does not select the
    // tenant — the session does. A "helpful" implementation that resolved the
    // organisation from `:id` and then checked membership would answer 200
    // here, and in doing so would route around the organisation-status check,
    // the MFA-enrolment gate and the permission check, all of which key on the
    // tenant `TenantContextGuard` resolved.
    const other = await member({});
    const actor = await member({});
    // Give the caller a real, ACTIVE membership in `other`'s organisation while
    // their session still points at their own.
    const role = await owner.role.findUniqueOrThrow({
      where: { key: 'OWNER' },
      select: { id: true },
    });
    await owner.membership.create({
      data: {
        id: newId('mbr'),
        organizationId: other.organizationId,
        userId: actor.userId,
        roleId: role.id,
        status: 'ACTIVE',
        deletedAt: null,
      },
      select: { id: true },
    });

    const response = await request(server)
      .get(`/api/v1/organizations/${other.organizationId}`)
      .set('Cookie', actor.cookie);

    expect(response.status).toBe(404);
    expect(codeOf(response.body)).toBe('RESOURCE_NOT_FOUND');
  });

  it('answers 404, byte-identical, for an id that does not exist', async () => {
    // The three cases must be indistinguishable. Compared by body rather than
    // by status alone, with `requestId` substituted out — carry-forward ruling
    // 77's technique, because that field varies per request by design.
    const a = await member({});
    const b = await member({});
    const strip = (body: unknown): unknown =>
      JSON.parse(JSON.stringify(body).replace(/"requestId":"[^"]*"/, '"requestId":"<id>"'));

    const missing = await request(server)
      .get(`/api/v1/organizations/${newId('org')}`)
      .set('Cookie', a.cookie);
    const otherTenant = await request(server)
      .get(`/api/v1/organizations/${b.organizationId}`)
      .set('Cookie', a.cookie);

    expect(missing.status).toBe(404);
    expect(strip(missing.body)).toEqual(strip(otherTenant.body));
  });

  it('answers 404 to a caller with no active organisation at all', async () => {
    // `TenantContextGuard` short-circuits before its query when
    // `activeOrganizationId` is NULL, and denies because the route declares a
    // permission. This is the branch that governed every request in the product
    // until this task and refused none of them.
    const suffix = unique();
    const user = await owner.user.create({
      data: {
        id: newId('usr'),
        email: `noorg-${suffix}@example.test`,
        emailVerifiedAt: new Date(),
        status: 'ACTIVE',
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
        activeOrganizationId: null,
        status: 'ACTIVE',
        idleExpiresAt: new Date(now + 86_400_000),
        absoluteExpiresAt: new Date(now + 7 * 86_400_000),
      },
    });

    const response = await request(server)
      .get(`/api/v1/organizations/${newId('org')}`)
      .set('Cookie', `${SESSION_COOKIE_NAME}=${minted.token}`);
    expect(response.status).toBe(404);
  });

  it('answers 403 ORGANIZATION_SUSPENDED for a member of a suspended organisation', async () => {
    // Layer 3, running on a shipped route for the first time. A member of a
    // suspended organisation IS a member — so 403 rather than 404 is right, and
    // it is not an information leak: they already know the organisation exists.
    const actor = await member({ organizationStatus: 'SUSPENDED' });
    const response = await request(server)
      .get(`/api/v1/organizations/${actor.organizationId}`)
      .set('Cookie', actor.cookie);

    expect(response.status).toBe(403);
    expect(codeOf(response.body)).toBe('ORGANIZATION_SUSPENDED');
  });

  it('refuses an anonymous caller with 401', async () => {
    const actor = await member({});
    const response = await request(server).get(`/api/v1/organizations/${actor.organizationId}`);
    expect(response.status).toBe(401);
  });
});

describe('PATCH /api/v1/organizations/:id', () => {
  it('renames it and writes ORGANIZATION_UPDATED in the same transaction', async () => {
    const actor = await member({});
    const response = await request(server)
      .patch(`/api/v1/organizations/${actor.organizationId}`)
      .set(csrf(actor))
      .send({ name: 'Renamed Ltd' });

    expect(response.status).toBe(200);
    expect(organizationResponseSchema.parse(response.body).name).toBe('Renamed Ltd');

    const events = await owner.auditEvent.findMany({
      where: { organizationId: actor.organizationId, action: 'ORGANIZATION_UPDATED' },
      select: { actorId: true, resourceId: true, metadata: true },
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.actorId).toBe(actor.userId);
    expect(events[0]?.resourceId).toBe(actor.organizationId);
    // Before and after, which `security/audit.md` §5 permits because a name is
    // not a sensitive field — and which is the whole question a rename audit
    // answers.
    expect(events[0]?.metadata).toMatchObject({ field: 'name', after: 'Renamed Ltd' });
  });

  it('answers 403 PERMISSION_DENIED to a role that lacks organization.update', async () => {
    // ARM 2 OF THE EXIT CRITERION, ON A PRODUCTION ENDPOINT FOR THE FIRST TIME.
    // `VIEWER` holds `organization.read` and not `organization.update`, so this
    // caller can read the very resource it is refused permission to change —
    // which is what makes 403 correct here where 404 is correct across tenants.
    const actor = await member({ role: 'VIEWER' });
    const response = await request(server)
      .patch(`/api/v1/organizations/${actor.organizationId}`)
      .set(csrf(actor))
      .send({ name: 'Not allowed' });

    expect(response.status).toBe(403);
    expect(codeOf(response.body)).toBe('PERMISSION_DENIED');

    // And nothing changed. A guard that refuses after the write is not a guard.
    const organization = await owner.organization.findUniqueOrThrow({
      where: { id: actor.organizationId },
      select: { name: true },
    });
    expect(organization.name).not.toBe('Not allowed');
  });

  it('answers 404 for another tenant’s organisation, not 403', async () => {
    const a = await member({});
    const b = await member({});
    const response = await request(server)
      .patch(`/api/v1/organizations/${b.organizationId}`)
      .set(csrf(a))
      .send({ name: 'Hijack' });

    expect(response.status).toBe(404);
    expect(codeOf(response.body)).toBe('RESOURCE_NOT_FOUND');
    const untouched = await owner.organization.findUniqueOrThrow({
      where: { id: b.organizationId },
      select: { name: true },
    });
    expect(untouched.name).not.toBe('Hijack');
  });

  it('refuses an empty patch with 400', async () => {
    // `updateOrganizationRequestSchema`'s refinement. Answering 200 to a no-op
    // teaches a client that its update worked.
    const actor = await member({});
    const response = await request(server)
      .patch(`/api/v1/organizations/${actor.organizationId}`)
      .set(csrf(actor))
      .send({});
    expect(response.status).toBe(400);
  });

  it('refuses a request with no CSRF header', async () => {
    const actor = await member({});
    const response = await request(server)
      .patch(`/api/v1/organizations/${actor.organizationId}`)
      .set('Cookie', actor.cookie)
      .send({ name: 'No CSRF' });
    expect(response.status).toBe(403);
    expect(codeOf(response.body)).toBe('CSRF_TOKEN_INVALID');
  });
});

describe('DELETE /api/v1/organizations/:id', () => {
  it('answers 409 and leaves the organisation standing', async () => {
    // D5's behaviour, reached by the database rather than by a check in
    // application code — and by a *different* database rule than D5 named. The
    // brief said the refusal comes from `AuditEvent.organizationId` being
    // `ON DELETE RESTRICT`. It does, second: migration `20260820132520` first
    // revokes `DELETE` on `Organization` from `sentinel_app` outright, because
    // "deleting a tenant is a platform-admin operation (Phase 11), not
    // something request-path code should be able to do at all". So this arm is
    // 409 whether or not the fixture below writes any history. Both rules are
    // asserted: this test supplies the audit history, and
    // `migration.integration.spec.ts` pins the missing privilege.
    const actor = await member({});
    await withAuditHistory(actor.organizationId, actor.userId);

    const response = await request(server)
      .delete(`/api/v1/organizations/${actor.organizationId}`)
      .set(csrf(actor));

    expect(response.status).toBe(409);
    expect(codeOf(response.body)).toBe('INVALID_STATE_TRANSITION');
    expect(await owner.organization.count({ where: { id: actor.organizationId } })).toBe(1);
  });

  it('answers 409 for an organisation created through this API, which audits itself', async () => {
    // THE CONSEQUENCE WORTH PINNING. `POST /organizations` writes
    // `ORGANIZATION_CREATED` in the transaction that creates the organisation,
    // so every organisation reachable through this API already has audit
    // history — and independently, the application role has no DELETE privilege
    // on the table at all. The success arm of `DELETE` is therefore unreachable
    // through the public API rather than merely rare. If this ever starts
    // returning 204, either creation stopped auditing, the foreign key was
    // weakened, or the privilege was re-granted; all three are defects, and
    // this assertion names them.
    const actor = await member({});
    const created = await request(server)
      .post('/api/v1/organizations')
      .set(csrf(actor))
      .send({ name: 'Self audited', slug: `selfaudit-${unique()}` });
    expect(created.status).toBe(201);
    const id = organizationResponseSchema.parse(created.body).id;

    // A SECOND, FRESH SESSION pointed at the new organisation, rather than
    // `UPDATE`ing the one already in flight. `SessionService` caches resolved
    // sessions in Redis and tombstones the entry on revocation, so a row
    // updated behind its back goes on resolving to the *old*
    // `activeOrganizationId` until the cache expires — which is how the first
    // version of this test got a 404 instead of a 409. Minting a new session is
    // what `switch-org` does in production, and it is the only way to change
    // the active organisation that this cache is coherent with.
    const minted = mintSecretToken();
    const now = Date.now();
    await owner.session.create({
      data: {
        id: newId('ses'),
        userId: actor.userId,
        tokenHash: minted.tokenHash,
        activeOrganizationId: id,
        status: 'ACTIVE',
        idleExpiresAt: new Date(now + 86_400_000),
        absoluteExpiresAt: new Date(now + 7 * 86_400_000),
      },
    });

    const response = await request(server)
      .delete(`/api/v1/organizations/${id}`)
      .set({
        Cookie: `${SESSION_COOKIE_NAME}=${minted.token}`,
        [CSRF_HEADER]: deriveCsrfToken(minted.token),
      });
    expect(response.status).toBe(409);
    expect(codeOf(response.body)).toBe('INVALID_STATE_TRANSITION');
    expect(await owner.organization.count({ where: { id } })).toBe(1);
  });

  it('answers 403 to a role that lacks organization.delete', async () => {
    // `ADMIN` holds `organization.update` and not `organization.delete`, which
    // is the sharpest available pair: the same caller may rename this
    // organisation and may not destroy it.
    const actor = await member({ role: 'ADMIN' });
    const response = await request(server)
      .delete(`/api/v1/organizations/${actor.organizationId}`)
      .set(csrf(actor));

    expect(response.status).toBe(403);
    expect(codeOf(response.body)).toBe('PERMISSION_DENIED');
  });

  it('answers 404 for another tenant’s organisation, and checks that before the 409', async () => {
    // Order matters. A caller naming somebody else's organisation must not
    // learn from a 409 that it exists and has an audit history.
    const a = await member({});
    const b = await member({});
    await withAuditHistory(b.organizationId, b.userId);

    const response = await request(server)
      .delete(`/api/v1/organizations/${b.organizationId}`)
      .set(csrf(a));

    expect(response.status).toBe(404);
    expect(codeOf(response.body)).toBe('RESOURCE_NOT_FOUND');
  });
});
