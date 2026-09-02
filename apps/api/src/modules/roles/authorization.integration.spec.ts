import type { Server } from 'node:http';
import { Controller, Get } from '@nestjs/common';
import { newId, seedReferenceData } from '@sentinel/db';
import {
  errorEnvelopeSchema,
  ROLE_PERMISSIONS,
  sessionResponseSchema,
  SYSTEM_ROLES,
  type ErrorEnvelope,
  type SystemRole,
} from '@sentinel/contracts';
import type { PrismaClient } from '@sentinel/db/unscoped';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthenticatedOnly, RequirePermission } from '../../common/decorators/access.decorator.js';
import { Ctx } from '../../common/decorators/ctx.decorator.js';
import { startAuthHarness, type AuthHarness } from '../../testing/auth-harness.js';
import { SESSION_COOKIE_NAME } from '../auth/cookies.js';
import { mintSecretToken } from '../auth/secret-token.js';

/**
 * LAYERS 2, 3 AND 4 OF `security/authorization.md` §2, AGAINST REAL SEEDED ROWS,
 * REAL ROW-LEVEL SECURITY, AND THE REAL GUARD CHAIN.
 *
 * # It connects as `sentinel_app`, and that is the point of the file
 *
 * Carry-forward ruling 75 named Task 12 as the task it binds hardest: the
 * integration harness's default `PRISMA` is the schema owner, a superuser that
 * **bypasses row-level security**, so an authorization suite run under it would
 * prove that Postgres has policies rather than that this code obeys them. The
 * application below is bound to `postgres.appUrl` — the least-privileged role
 * the API process really connects as. Fixtures are seeded through the owner
 * client, which is the one thing the owner is the right tool for.
 *
 * The consequence is that deleting `withTenantTransaction` from
 * `tenant-resolver.store.ts` turns this file red rather than leaving it green:
 * without `app.organization_id` set, `Membership` and `Organization` return
 * zero rows for this role and every arm collapses to 404.
 *
 * # The guarded routes here are purpose-built, and shipped ones now exist too
 *
 * Task 13 shipped the first three permission-guarded endpoints — `GET`, `PATCH`
 * and `DELETE /api/v1/organizations/:id` — which the generated matrix in
 * `authorization-matrix.integration.spec.ts` exercises. This file keeps its own
 * purpose-built controller anyway, because it exercises arms and roles the
 * shipped routes cannot reach: every system role against every permission,
 * including combinations no organisation endpoint expresses. Through Task 12 no
 * shipped route was guarded at all and this paragraph said so.
 *
 * The controller below is added to the **real** `AppModule`,
 * so everything except the endpoint is production: the real guard array in the
 * real order, the real resolver, the real Postgres, the real session cookie.
 *
 * # `Session.activeOrganizationId` is written directly, because nothing writes it
 *
 * Organisation creation and switching are Task 13's, and there is no login path
 * that can set the column, so the fixture writes it directly through the owner
 * client. That is itself the reason the roadmap must not describe this control
 * as governing any production request.
 */

@Controller('probe')
class ProbeController {
  @RequirePermission('scan.create')
  @Get('scan-create')
  scanCreate(@Ctx() ctx: { organizationId: string; roleKey: string }): {
    organizationId: string;
    roleKey: string;
  } {
    return { organizationId: ctx.organizationId, roleKey: ctx.roleKey };
  }

  @RequirePermission('finding.accept_risk')
  @Get('accept-risk')
  acceptRisk(): { ok: true } {
    return { ok: true };
  }

  @AuthenticatedOnly()
  @Get('anyone')
  anyone(): { ok: true } {
    return { ok: true };
  }
}

/**
 * The refusal, parsed through the published envelope rather than read off an
 * `any`. `errorEnvelopeSchema` is the contract `AllExceptionsFilter` produces,
 * so a body that does not match it fails here rather than surviving as
 * `undefined === undefined`.
 */
const envelopeOf = (body: unknown): ErrorEnvelope => errorEnvelopeSchema.parse(body);
const codeOf = (body: unknown): string => envelopeOf(body).error.code;

let harness: AuthHarness;
let owner: PrismaClient;
let server: Server;

beforeAll(async () => {
  harness = await startAuthHarness({ connectAs: 'app', controllers: [ProbeController] });
  owner = harness.prisma;
  server = harness.server;
  await seedReferenceData(owner);
}, 240_000);

afterAll(async () => {
  await harness?.stop();
});

let counter = 0;

/**
 * One organisation, one user, one membership at the given role, and a live
 * session already pointed at that organisation.
 *
 * Seeded through the owner client rather than through the API, because the API
 * has no endpoint that creates an organisation until Task 13 and no endpoint
 * that sets a session's active organisation at all.
 */
async function member(options: {
  role: SystemRole;
  organizationStatus?: 'ACTIVE' | 'SUSPENDED';
  membershipStatus?: 'ACTIVE' | 'INVITED' | 'REMOVED';
  organizationId?: string;
}): Promise<{ cookie: string; userId: string; organizationId: string; membershipId: string }> {
  counter += 1;
  const suffix = `${String(counter)}-${String(Date.now())}`;

  const organizationId =
    options.organizationId ??
    (
      await owner.organization.create({
        data: {
          id: newId('org'),
          slug: `authz-${suffix}`,
          name: `Authz ${suffix}`,
          status: options.organizationStatus ?? 'ACTIVE',
        },
        select: { id: true },
      })
    ).id;

  const user = await owner.user.create({
    data: {
      id: newId('usr'),
      email: `authz-${suffix}@example.test`,
      emailVerifiedAt: new Date(),
      status: 'ACTIVE',
    },
    select: { id: true },
  });

  const role = await owner.role.findUniqueOrThrow({
    where: { key: options.role },
    select: { id: true },
  });

  const membershipStatus = options.membershipStatus ?? 'ACTIVE';
  const membership = await owner.membership.create({
    data: {
      id: newId('mbr'),
      organizationId,
      userId: user.id,
      roleId: role.id,
      status: membershipStatus,
      // Carry-forward ruling 10: the CHECK constraint makes `REMOVED` and
      // soft-deleted the same fact, so a bare `status: 'REMOVED'` is an invalid
      // write. The two move together or the insert is refused.
      deletedAt: membershipStatus === 'REMOVED' ? new Date() : null,
    },
    select: { id: true },
  });

  // Minted by the real generator, so the row carries a token of exactly the
  // shape `SessionService.resolve` will hash and look up. A hand-built string
  // would be a fixture that happens to work until the format is validated.
  const minted = mintSecretToken();
  const now = Date.now();
  await owner.session.create({
    data: {
      id: newId('ses'),
      userId: user.id,
      tokenHash: minted.tokenHash,
      activeOrganizationId: organizationId,
      status: 'ACTIVE',
      idleExpiresAt: new Date(now + 24 * 60 * 60 * 1000),
      absoluteExpiresAt: new Date(now + 7 * 24 * 60 * 60 * 1000),
    },
  });

  return {
    cookie: `${SESSION_COOKIE_NAME}=${minted.token}`,
    userId: user.id,
    organizationId,
    membershipId: membership.id,
  };
}

const get = (path: string, cookie?: string): request.Test => {
  const call = request(server).get(path);
  return cookie === undefined ? call : call.set('Cookie', cookie);
};

describe('the seeded rows are the authority, and they match the contracts', () => {
  /**
   * Carry-forward rulings 5, 13 and 27's family: two lists that must agree, with
   * nothing between them. `tenant-resolver.store.ts` computes the effective set
   * from the seeded `RolePermission` rows, and `authorization.guard.ts` builds
   * its "who can grant this" hint from `ROLE_PERMISSIONS`. If those two drifted,
   * a caller would be refused for a permission the hint said their own role
   * held.
   */
  it('expands every system role to exactly ROLE_PERMISSIONS', async () => {
    for (const key of SYSTEM_ROLES) {
      const role = await owner.role.findUniqueOrThrow({
        where: { key },
        select: { permissions: { select: { permission: { select: { key: true } } } } },
      });
      const seeded = role.permissions.map((grant) => grant.permission.key).sort();
      expect(seeded).toEqual([...ROLE_PERMISSIONS[key]].sort());
    }
  });
});

describe('layer 4 — permission', () => {
  it('admits a member whose role holds the declared permission', async () => {
    const actor = await member({ role: 'MEMBER' });
    const response = await get('/api/v1/probe/scan-create', actor.cookie);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ organizationId: actor.organizationId, roleKey: 'MEMBER' });
  });

  it('refuses a member whose role does not, with 403 PERMISSION_DENIED', async () => {
    const actor = await member({ role: 'MEMBER' });
    const response = await get('/api/v1/probe/accept-risk', actor.cookie);
    expect(response.status).toBe(403);
    expect(codeOf(response.body)).toBe('PERMISSION_DENIED');
    expect(envelopeOf(response.body).error.details?.yourRole).toBe('MEMBER');
  });

  it('admits an OWNER everywhere, because OWNER holds every permission', async () => {
    const actor = await member({ role: 'OWNER' });
    await get('/api/v1/probe/scan-create', actor.cookie).expect(200);
    await get('/api/v1/probe/accept-risk', actor.cookie).expect(200);
  });

  it('refuses a VIEWER a write permission its role does not hold', async () => {
    const actor = await member({ role: 'VIEWER' });
    const response = await get('/api/v1/probe/scan-create', actor.cookie);
    expect(response.status).toBe(403);
  });
});

describe('layer 2 — membership', () => {
  it('answers 404 for a session pointed at an organisation with no membership', async () => {
    const stranger = await member({ role: 'OWNER' });
    const other = await member({ role: 'OWNER' });
    // Point the stranger's session at the other organisation. This is the
    // cross-tenant case: a real credential, a real organisation, no membership.
    await owner.session.updateMany({
      where: { userId: stranger.userId },
      data: { activeOrganizationId: other.organizationId },
    });
    const response = await get('/api/v1/probe/scan-create', stranger.cookie);
    expect(response.status).toBe(404);
    expect(codeOf(response.body)).toBe('RESOURCE_NOT_FOUND');
  });

  it('answers 404 for a membership that exists and is not active', async () => {
    const invited = await member({ role: 'OWNER', membershipStatus: 'INVITED' });
    const response = await get('/api/v1/probe/scan-create', invited.cookie);
    expect(response.status).toBe(404);
  });

  it('answers 404 for a removed member', async () => {
    const removed = await member({ role: 'OWNER', membershipStatus: 'REMOVED' });
    const response = await get('/api/v1/probe/scan-create', removed.cookie);
    expect(response.status).toBe(404);
  });

  /**
   * §6's rule as an identity: "Cross-tenant access returns 404, identical to a
   * genuinely absent resource." Same status, same body, same headers — the
   * plan names all three, so all three are asserted.
   */
  it('is byte-identical to the refusal for a session with no organisation', async () => {
    const stranger = await member({ role: 'OWNER' });
    const other = await member({ role: 'OWNER' });
    await owner.session.updateMany({
      where: { userId: stranger.userId },
      data: { activeOrganizationId: other.organizationId },
    });
    const crossTenant = await get('/api/v1/probe/scan-create', stranger.cookie);

    const homeless = await member({ role: 'OWNER' });
    await owner.session.updateMany({
      where: { userId: homeless.userId },
      data: { activeOrganizationId: null },
    });
    const noOrganisation = await get('/api/v1/probe/scan-create', homeless.cookie);

    expect(crossTenant.status).toBe(404);
    expect(noOrganisation.status).toBe(404);

    const normalise = (body: unknown): string => {
      const envelope = envelopeOf(body);
      return JSON.stringify({
        ...envelope,
        error: { ...envelope.error, requestId: 'X', timestamp: 'X' },
      });
    };
    expect(normalise(crossTenant.body)).toBe(normalise(noOrganisation.body));
    expect(Object.keys(crossTenant.headers).sort()).toEqual(
      Object.keys(noOrganisation.headers).sort(),
    );
  });

  /**
   * THE ASYMMETRY. A removed member must still reach the routes that are about
   * them and not about a tenant, or they hold a credential no endpoint answers
   * — logout included.
   */
  it('still admits an @AuthenticatedOnly() route for a removed member', async () => {
    const removed = await member({ role: 'OWNER', membershipStatus: 'REMOVED' });
    await get('/api/v1/probe/anyone', removed.cookie).expect(200);
    await get('/api/v1/auth/session', removed.cookie).expect(200);
  });
});

describe('a re-added member, with removed rows left behind', () => {
  /**
   * THE TASK 12 REVIEW'S M-1, AS A TEST — AND THE FIRST VERSION OF THIS TEST
   * DID NOT BITE.
   *
   * `(organizationId, userId)` is unique only **where `deletedAt` is null**, so
   * a member who was removed and later re-added leaves `REMOVED` rows sitting
   * beside the live one. The resolver's `findFirst` originally had no predicate
   * and no `orderBy`, so Postgres could return any of them — and a `REMOVED`
   * row reads as `not-a-member`, which is a silent 404 on every guarded route
   * for a member who is active. This is the shape Task 14's removal and Task
   * 15's re-invitation produce together.
   *
   * **The row order is the whole test, and getting it wrong made the first
   * version pass under the mutation.** That version inserted the removed rows
   * *after* the live one, with a comment claiming that was the arrangement
   * least likely to catch the defect by luck. The opposite is true: with no
   * `ORDER BY`, Postgres seq-scans a small table in physical order, so the
   * live row — inserted first — came back first and the mutated resolver
   * answered 200. Carry-forward ruling 88: measure the guard, not just the fix.
   *
   * So this reproduces the real sequence instead. The original membership is
   * removed, a second removal is left behind, and the member is then re-added —
   * which puts the live row **last** in physical order, exactly where an
   * unordered `LIMIT 1` will not find it.
   */
  it('resolves the live membership and not a removed one', async () => {
    const actor = await member({ role: 'OWNER' });
    const viewer = await owner.role.findUniqueOrThrow({
      where: { key: 'VIEWER' },
      select: { id: true },
    });

    // 1. The original membership is removed. Ruling 10: status and `deletedAt`
    //    are one fact and the CHECK constraint refuses them apart.
    await owner.membership.update({
      where: { id: actor.membershipId },
      data: { status: 'REMOVED', deletedAt: new Date() },
    });

    // 2. A second removal left behind, so the live row is not merely second.
    await owner.membership.create({
      data: {
        id: newId('mbr'),
        organizationId: actor.organizationId,
        userId: actor.userId,
        roleId: viewer.id,
        status: 'REMOVED',
        deletedAt: new Date(),
      },
      select: { id: true },
    });

    // 3. Re-added. This row is LAST, which is the arrangement that catches an
    //    unordered read.
    const readded = await owner.membership.create({
      data: {
        id: newId('mbr'),
        organizationId: actor.organizationId,
        userId: actor.userId,
        roleId: (
          await owner.role.findUniqueOrThrow({ where: { key: 'OWNER' }, select: { id: true } })
        ).id,
        status: 'ACTIVE',
        deletedAt: null,
      },
      select: { id: true },
    });
    expect(readded.id).not.toBe(actor.membershipId);

    const rows = await owner.membership.count({
      where: { organizationId: actor.organizationId, userId: actor.userId },
    });
    expect(rows).toBe(3);

    // The removed rows carry VIEWER and the live one carries OWNER, so reading
    // the wrong row shows up as a 403 as well as a 404 — the resolved role is
    // asserted, not only the status code.
    const response = await get('/api/v1/probe/scan-create', actor.cookie);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ organizationId: actor.organizationId, roleKey: 'OWNER' });
    await get('/api/v1/probe/accept-risk', actor.cookie).expect(200);
  });
});

describe('layer 3 — organisation state', () => {
  it('refuses an active member of a suspended organisation with 403', async () => {
    const actor = await member({ role: 'OWNER', organizationStatus: 'SUSPENDED' });
    const response = await get('/api/v1/probe/scan-create', actor.cookie);
    expect(response.status).toBe(403);
    expect(codeOf(response.body)).toBe('ORGANIZATION_SUSPENDED');
  });

  /**
   * THE LAYER ORDER, OVER REAL ROWS. A non-member of a suspended organisation
   * hears the membership answer — the suspension is a fact about somebody
   * else's tenancy and 403 would disclose it.
   */
  it('answers 404, not 403, for a NON-member of a suspended organisation', async () => {
    const suspended = await member({ role: 'OWNER', organizationStatus: 'SUSPENDED' });
    const stranger = await member({ role: 'OWNER' });
    await owner.session.updateMany({
      where: { userId: stranger.userId },
      data: { activeOrganizationId: suspended.organizationId },
    });
    const response = await get('/api/v1/probe/scan-create', stranger.cookie);
    expect(response.status).toBe(404);
    expect(codeOf(response.body)).toBe('RESOURCE_NOT_FOUND');
  });
});

describe('permissions.md invariant 4 — a role change takes effect on the next request', () => {
  /**
   * THE INVARIANT IS STRUCTURAL, NOT MAINTAINED.
   *
   * There is no permission cache and therefore no `invalidate()` for Task 14's
   * role change or Task 15's invitation acceptance to forget to call. The
   * decision was put to the operator on 2026-09-02 with a Redis-backed cache as
   * the alternative; `tenant-resolver.store.ts` records the reasoning.
   *
   * This test is what the plan asked for and it is written to be able to fail:
   * the same session, the same cookie, two requests either side of one UPDATE,
   * with no logout and no rotation in between.
   */
  it('a promoted member gains the permission without signing in again', async () => {
    const actor = await member({ role: 'MEMBER' });
    await get('/api/v1/probe/accept-risk', actor.cookie).expect(403);

    const lead = await owner.role.findUniqueOrThrow({
      where: { key: 'SECURITY_LEAD' },
      select: { id: true },
    });
    await owner.membership.update({
      where: { id: actor.membershipId },
      data: { roleId: lead.id },
    });

    await get('/api/v1/probe/accept-risk', actor.cookie).expect(200);
  });

  it('a demoted member loses it on the next request', async () => {
    // The direction that matters more: a stale grant is a privilege that
    // outlives the decision to remove it.
    const actor = await member({ role: 'OWNER' });
    await get('/api/v1/probe/accept-risk', actor.cookie).expect(200);

    const viewer = await owner.role.findUniqueOrThrow({
      where: { key: 'VIEWER' },
      select: { id: true },
    });
    await owner.membership.update({
      where: { id: actor.membershipId },
      data: { roleId: viewer.id },
    });

    await get('/api/v1/probe/accept-risk', actor.cookie).expect(403);
  });

  it('a removed member loses everything on the next request', async () => {
    const actor = await member({ role: 'OWNER' });
    await get('/api/v1/probe/scan-create', actor.cookie).expect(200);

    await owner.membership.update({
      where: { id: actor.membershipId },
      // Ruling 10: status and deletedAt are one fact.
      data: { status: 'REMOVED', deletedAt: new Date() },
    });

    const response = await get('/api/v1/probe/scan-create', actor.cookie);
    expect(response.status).toBe(404);
  });
});

describe('GET /auth/session reports the resolved permission set', () => {
  it('lists the effective permissions for an active member', async () => {
    const actor = await member({ role: 'AUDITOR' });
    const response = await get('/api/v1/auth/session', actor.cookie);
    expect(response.status).toBe(200);
    expect(sessionResponseSchema.parse(response.body).permissions).toEqual(
      [...ROLE_PERMISSIONS.AUDITOR].sort(),
    );
  });

  it('reports an empty set for a member of a suspended organisation', async () => {
    // A member of a suspended organisation may do nothing in it, so an
    // *effective* permission set of nothing is the accurate report. The route
    // is @AuthenticatedOnly(), so the caller still gets their document.
    const actor = await member({ role: 'OWNER', organizationStatus: 'SUSPENDED' });
    const response = await get('/api/v1/auth/session', actor.cookie);
    expect(response.status).toBe(200);
    expect(sessionResponseSchema.parse(response.body).permissions).toEqual([]);
  });

  it('reports an empty set when the session names no organisation', async () => {
    const actor = await member({ role: 'OWNER' });
    await owner.session.updateMany({
      where: { userId: actor.userId },
      data: { activeOrganizationId: null },
    });
    const response = await get('/api/v1/auth/session', actor.cookie);
    expect(response.status).toBe(200);
    expect(sessionResponseSchema.parse(response.body).permissions).toEqual([]);
  });
});
