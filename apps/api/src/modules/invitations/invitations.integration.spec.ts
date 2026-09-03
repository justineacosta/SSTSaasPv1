import type { Server } from 'node:http';
import {
  errorEnvelopeSchema,
  invitationCollectionSchema,
  invitationResponseSchema,
  type ErrorEnvelope,
  type SystemRole,
} from '@sentinel/contracts';
import { newId, seedReferenceData } from '@sentinel/db';
import { createUnscopedPrismaClient, type PrismaClient } from '@sentinel/db/unscoped';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearRateLimits, startAuthHarness, type AuthHarness } from '../../testing/auth-harness.js';
import { CSRF_HEADER } from '../../common/guards/csrf.guard.js';
import { SESSION_COOKIE_NAME } from '../auth/cookies.js';
import { deriveCsrfToken } from '../auth/csrf-token.js';
import { hashSecretToken, mintSecretToken } from '../auth/secret-token.js';

/**
 * THE THREE INVITATION ROUTES, AGAINST REAL ROW-LEVEL SECURITY, THE REAL GUARD
 * CHAIN, REAL SEEDED ROWS AND A REAL RATE-LIMIT WINDOW.
 *
 * # It connects as `sentinel_app`
 *
 * Carry-forward rulings 58 and 75, and the same choice
 * `memberships.integration.spec.ts` makes. The harness's default `PRISMA` is
 * the schema owner, a superuser that bypasses row-level security, so a suite run
 * under it would show that Postgres has policies rather than that this code
 * obeys them. Fixtures are seeded through the owner client, which is the one
 * thing the owner is right for.
 *
 * # What is deliberately NOT here
 *
 * **Acceptance.** `POST /api/v1/invitations/accept` is not shipped and the
 * reason is measured in `invitations.controller.ts`'s docblock: the acceptor is
 * a member of nothing, so no organisation is resolved, and `Invitation` carries
 * `FORCE ROW LEVEL SECURITY` keyed on `organizationId` — the handler cannot read
 * the invitation its own token names. The tests the brief names for that path
 * (a different signed-in user cannot consume someone else's invitation; two
 * concurrent accepts yield exactly one membership; invite → accept → remove →
 * invite → accept end to end) are therefore not written, rather than written
 * against something that does not exist.
 */

const envelopeOf = (body: unknown): ErrorEnvelope => errorEnvelopeSchema.parse(body);
const codeOf = (body: unknown): string => envelopeOf(body).error.code;

let harness: AuthHarness;
let owner: PrismaClient;
let server: Server;
/**
 * One more `sentinel_app` connection, so a session-level advisory lock can
 * actually be held while a request runs. It has to be a separate client: a
 * session-level `pg_advisory_lock` belongs to the connection that took it, and
 * taking it on the pool the application shares would block the application
 * against itself.
 */
let blockerConnection: PrismaClient;

beforeAll(async () => {
  harness = await startAuthHarness({ connectAs: 'app' });
  owner = harness.prisma;
  server = harness.server;
  blockerConnection = createUnscopedPrismaClient(harness.postgres.appUrl);
  await seedReferenceData(owner);
}, 240_000);

afterAll(async () => {
  await blockerConnection?.$disconnect();
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
}

async function user(options: { emailVerified?: boolean } = {}): Promise<{
  id: string;
  email: string;
}> {
  return owner.user.create({
    data: {
      id: newId('usr'),
      email: `invites-${unique()}@example.test`,
      emailVerifiedAt: (options.emailVerified ?? true) ? new Date() : null,
      status: 'ACTIVE',
    },
    select: { id: true, email: true },
  });
}

async function sessionFor(userId: string, activeOrganizationId: string | null): Promise<Actor> {
  const minted = mintSecretToken();
  const now = Date.now();
  await owner.session.create({
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
  return { cookie: `${SESSION_COOKIE_NAME}=${minted.token}`, token: minted.token, userId };
}

async function organization(): Promise<string> {
  const suffix = unique();
  const created = await owner.organization.create({
    data: { id: newId('org'), slug: `invites-${suffix}`, name: `Invites ${suffix}` },
    select: { id: true },
  });
  return created.id;
}

async function membership(options: {
  organizationId: string;
  userId: string;
  role: SystemRole;
  status?: 'ACTIVE' | 'REMOVED';
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
 * An invitation written straight into the table, for the cases the endpoint
 * cannot produce — an expired one, an accepted one, another tenant's.
 */
async function invitation(options: {
  organizationId: string;
  email: string;
  invitedByUserId: string;
  role?: SystemRole;
  expiresAt?: Date;
  acceptedAt?: Date;
  revokedAt?: Date;
}): Promise<string> {
  const role = await owner.role.findUniqueOrThrow({
    where: { key: options.role ?? 'MEMBER' },
    select: { id: true },
  });
  const id = newId('inv');
  await owner.invitation.create({
    data: {
      id,
      organizationId: options.organizationId,
      email: options.email,
      roleId: role.id,
      tokenHash: hashSecretToken(`fixture-${id}`),
      invitedByUserId: options.invitedByUserId,
      expiresAt: options.expiresAt ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      acceptedAt: options.acceptedAt ?? null,
      revokedAt: options.revokedAt ?? null,
    },
    select: { id: true },
  });
  return id;
}

/**
 * One organisation with an actor already acting in it at the given role.
 *
 * `activeOrganizationId` is written directly rather than through
 * `POST /auth/switch-org`, for the reason `memberships.integration.spec.ts`
 * gives: using the endpoint would make every case here depend on another
 * endpoint's correctness.
 */
async function acting(
  role: SystemRole,
  options: { emailVerified?: boolean } = {},
): Promise<{ actor: Actor; organizationId: string }> {
  const organizationId = await organization();
  const account = await user(options);
  await membership({ organizationId, userId: account.id, role });
  const actor = await sessionFor(account.id, organizationId);
  return { actor, organizationId };
}

const csrf = (actor: Actor): Record<string, string> => ({
  Cookie: actor.cookie,
  [CSRF_HEADER]: deriveCsrfToken(actor.token),
});

const invitesPath = (organizationId: string): string =>
  `/api/v1/organizations/${organizationId}/invitations`;

const sentTo = (address: string): number =>
  harness.sent.filter((mail) => mail.to === address).length;

describe('POST /api/v1/organizations/:id/invitations', () => {
  it('creates an invitation, sends exactly one message, and returns no token', async () => {
    await clearRateLimits(harness.redis);
    const { actor, organizationId } = await acting('OWNER');
    const invitee = `newcomer-${unique()}@example.test`;

    const response = await request(server)
      .post(invitesPath(organizationId))
      .set(csrf(actor))
      .send({ email: invitee, roleKey: 'MEMBER' });

    expect(response.status).toBe(201);
    const body = invitationResponseSchema.parse(response.body);
    expect(body.email).toBe(invitee);
    expect(body.roleKey).toBe('MEMBER');
    expect(body.invitedByUserId).toBe(actor.userId);
    expect(body.acceptedAt).toBeNull();
    expect(body.revokedAt).toBeNull();

    // THE RAW BODY, NOT THE PARSED ONE. `invitationResponseSchema` is not
    // `.strict()`, so parsing would strip a token the handler had leaked and
    // the assertion would pass over the defect it exists to catch. Serialised
    // and searched, so a token nested anywhere in the payload is caught rather
    // than only a top-level `token` key.
    const raw = JSON.stringify(response.body);
    expect(raw).not.toContain('token');
    expect(raw).not.toContain('Hash');

    const stored = await owner.invitation.findUniqueOrThrow({
      where: { id: body.id },
      select: { tokenHash: true, expiresAt: true },
    });
    // 43 base64url characters is the minted length; a hash is 64 hex. The row
    // must hold the hash, and the token itself must not be recoverable from it.
    expect(stored.tokenHash).toHaveLength(64);
    expect(stored.expiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 60 * 60 * 1000);

    expect(sentTo(invitee)).toBe(1);
    const message = harness.sent.filter((mail) => mail.to === invitee)[0];
    expect(message?.templateId).toBe('invitation');
    // Ruling 41: the secret travels as `?token=` on a query string, which is
    // the only shape the redacting logger covers.
    expect(message?.text).toContain('?token=');

    const events = await owner.auditEvent.findMany({
      where: { organizationId, action: 'MEMBER_INVITED' },
      select: { resourceType: true, resourceId: true, actorId: true, metadata: true },
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.resourceType).toBe('Invitation');
    expect(events[0]?.resourceId).toBe(body.id);
    expect(events[0]?.actorId).toBe(actor.userId);
    expect(events[0]?.metadata).toMatchObject({
      email: invitee,
      roleKey: 'MEMBER',
      supersededInvitationId: null,
    });
    // Ruling 38, asserted rather than assumed: the raw token never enters an
    // audit event's metadata.
    expect(JSON.stringify(events[0]?.metadata)).not.toContain('token');
  });

  it('applies the per-organisation rate limit, which no route could reach before this task', async () => {
    // The window is 50/day and spending it would be 51 requests; what is
    // asserted instead is that the limit **engaged** — the guard sets
    // `RateLimit-*` on every response it decided, allowed or refused, and it
    // can only decide when `perOrganization` resolved. Before the limiter was
    // split into two phases this route answered 429 to everything, so the 201
    // above is already half the proof and the header is the other half:
    // it names the class's own figure rather than some other window's.
    await clearRateLimits(harness.redis);
    const { actor, organizationId } = await acting('OWNER');

    const response = await request(server)
      .post(invitesPath(organizationId))
      .set(csrf(actor))
      .send({ email: `limited-${unique()}@example.test`, roleKey: 'MEMBER' });

    expect(response.status).toBe(201);
    expect(response.headers['ratelimit-limit']).toBe('50');
    expect(response.headers['ratelimit-remaining']).toBe('49');

    // The window is the ORGANISATION's, so a second invitation from the same
    // organisation spends it further and one from another organisation does
    // not. A limit keyed on the wrong thing passes the two assertions above and
    // fails these.
    const second = await request(server)
      .post(invitesPath(organizationId))
      .set(csrf(actor))
      .send({ email: `limited-${unique()}@example.test`, roleKey: 'MEMBER' });
    expect(second.headers['ratelimit-remaining']).toBe('48');

    const other = await acting('OWNER');
    const elsewhere = await request(server)
      .post(invitesPath(other.organizationId))
      .set(csrf(other.actor))
      .send({ email: `limited-${unique()}@example.test`, roleKey: 'MEMBER' });
    expect(elsewhere.headers['ratelimit-remaining']).toBe('49');
  });

  it('refuses an unverified caller with 403, which the list and revoke routes do not', async () => {
    // `security/authentication.md` §6: an unverified user cannot invite. The
    // second half is the assertion that matters — the gate is on this route and
    // not on the controller, so the same unverified actor may still read.
    await clearRateLimits(harness.redis);
    const { actor, organizationId } = await acting('OWNER', { emailVerified: false });

    const refused = await request(server)
      .post(invitesPath(organizationId))
      .set(csrf(actor))
      .send({ email: `unverified-${unique()}@example.test`, roleKey: 'MEMBER' });
    expect(refused.status).toBe(403);
    expect(codeOf(refused.body)).toBe('EMAIL_NOT_VERIFIED');

    const allowed = await request(server).get(invitesPath(organizationId)).set(csrf(actor));
    expect(allowed.status).toBe(200);
  });

  it('refuses an ADMIN inviting an OWNER with 403, naming the permission they lack', async () => {
    // D5, `security/authorization.md` §4's no-minting rule at its third call
    // site. An `ADMIN` holds `organization.manage_members` but not
    // `organization.delete`, which `OWNER` holds — so offering `OWNER` would
    // mint authority the actor does not possess. Carry-forward ruling 124 is
    // why this is the same rule the role change and the removal enforce.
    await clearRateLimits(harness.redis);
    const { actor, organizationId } = await acting('ADMIN');

    const refused = await request(server)
      .post(invitesPath(organizationId))
      .set(csrf(actor))
      .send({ email: `owner-${unique()}@example.test`, roleKey: 'OWNER' });

    expect(refused.status).toBe(403);
    expect(codeOf(refused.body)).toBe('PERMISSION_DENIED');
    expect(envelopeOf(refused.body).error.message).toContain('organization.delete');

    // The same ADMIN may invite an ADMIN — an equal permission set — so the
    // refusal above is about the set comparison and not about the role change
    // being refused outright.
    const allowed = await request(server)
      .post(invitesPath(organizationId))
      .set(csrf(actor))
      .send({ email: `admin-${unique()}@example.test`, roleKey: 'ADMIN' });
    expect(allowed.status).toBe(201);

    // Nothing was written for the refusal: the transaction rolled back and
    // the audit row with it.
    expect(
      await owner.auditEvent.count({
        where: { organizationId, action: 'MEMBER_INVITED' },
      }),
    ).toBe(1);
  });

  it('supersedes the live invitation for the same address rather than colliding with it', async () => {
    // D4. The partial unique index
    // `Invitation_organizationId_email_live_key` allows exactly one live row
    // per (organisation, address), so without the supersede the second call
    // would raise P2002 and answer 500.
    await clearRateLimits(harness.redis);
    const { actor, organizationId } = await acting('OWNER');
    const invitee = `resend-${unique()}@example.test`;

    const first = await request(server)
      .post(invitesPath(organizationId))
      .set(csrf(actor))
      .send({ email: invitee, roleKey: 'VIEWER' });
    expect(first.status).toBe(201);

    const second = await request(server)
      .post(invitesPath(organizationId))
      .set(csrf(actor))
      .send({ email: invitee, roleKey: 'MEMBER' });
    expect(second.status).toBe(201);

    const firstId = invitationResponseSchema.parse(first.body).id;
    const secondId = invitationResponseSchema.parse(second.body).id;
    expect(secondId).not.toBe(firstId);

    const rows = await owner.invitation.findMany({
      where: { organizationId, email: invitee },
      select: { id: true, revokedAt: true, role: { select: { key: true } } },
    });
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === firstId)?.revokedAt).not.toBeNull();
    expect(rows.find((row) => row.id === secondId)?.revokedAt).toBeNull();
    // The new invitation carries the new role, so a re-invitation is how an
    // offer is corrected.
    expect(rows.find((row) => row.id === secondId)?.role.key).toBe('MEMBER');

    // THE SUPERSEDED ROW GETS NO `INVITATION_REVOKED` EVENT OF ITS OWN.
    // `audit.actions.ts` records why: that name means a person revoked it and a
    // reader would look for the actor. The supersession is a field of the event
    // that caused it.
    expect(
      await owner.auditEvent.count({ where: { organizationId, action: 'INVITATION_REVOKED' } }),
    ).toBe(0);
    const invited = await owner.auditEvent.findMany({
      where: { organizationId, action: 'MEMBER_INVITED' },
      orderBy: { createdAt: 'asc' },
      select: { resourceId: true, metadata: true },
    });
    expect(invited).toHaveLength(2);
    expect(invited[0]?.metadata).toMatchObject({ supersededInvitationId: null });
    expect(invited[1]?.metadata).toMatchObject({ supersededInvitationId: firstId });
  });

  it('supersedes an EXPIRED invitation too, which the index predicate cannot cover', async () => {
    // The index predicate is `WHERE "acceptedAt" IS NULL AND "revokedAt" IS
    // NULL` and cannot mention expiry: a partial index predicate must be
    // IMMUTABLE and `"expiresAt" > now()` is not. So an expired row still holds
    // the slot, and only the supersede frees it. Delete the `updateMany` in
    // `create` and this test fails with a P2002-derived 500 while the
    // supersede-a-live-one test above still passes on its own reasoning.
    await clearRateLimits(harness.redis);
    const { actor, organizationId } = await acting('OWNER');
    const invitee = `expired-${unique()}@example.test`;
    const stale = await invitation({
      organizationId,
      email: invitee,
      invitedByUserId: actor.userId,
      expiresAt: new Date(Date.now() - 60_000),
    });

    const response = await request(server)
      .post(invitesPath(organizationId))
      .set(csrf(actor))
      .send({ email: invitee, roleKey: 'MEMBER' });

    expect(response.status).toBe(201);
    expect(
      (
        await owner.invitation.findUniqueOrThrow({
          where: { id: stale },
          select: { revokedAt: true },
        })
      ).revokedAt,
    ).not.toBeNull();
    const live = await owner.invitation.count({
      where: { organizationId, email: invitee, acceptedAt: null, revokedAt: null },
    });
    expect(live).toBe(1);
  });

  it('refuses an address that is already a live member with 409', async () => {
    await clearRateLimits(harness.redis);
    const { actor, organizationId } = await acting('OWNER');
    const colleague = await user();
    await membership({ organizationId, userId: colleague.id, role: 'MEMBER' });

    const response = await request(server)
      .post(invitesPath(organizationId))
      .set(csrf(actor))
      .send({ email: colleague.email, roleKey: 'ADMIN' });

    expect(response.status).toBe(409);
    expect(codeOf(response.body)).toBe('DUPLICATE_RESOURCE');
    expect(await owner.invitation.count({ where: { organizationId } })).toBe(0);
  });

  it('RULING 99/100 — re-invites a REMOVED member, with the live rows arranged to lose', async () => {
    // The case Task 1's partial index exists for, and the arrangement is the
    // test rather than an implementation detail.
    //
    // Ruling 99: `(organizationId, userId)` is unique on `Membership` only
    // `WHERE "deletedAt" IS NULL`, so a person who has been removed and re-added
    // has several rows and an unordered read may return a `REMOVED` one.
    // Ruling 100: a regression test for a non-deterministic read has to be
    // ARRANGED TO LOSE. Postgres seq-scans a small table in physical order, so
    // the fixture below writes the removed rows FIRST and the live one LAST for
    // the "already a member" arm — a resolver without `deletedAt: null` then
    // returns a removed row and wrongly allows the invitation — and writes the
    // live-then-removed order for the re-invite arm, where a resolver without
    // the predicate returns the ACTIVE row and wrongly refuses.
    await clearRateLimits(harness.redis);

    // Arm 1 — genuinely removed, and there is an older ACTIVE row physically
    // BEFORE the removed one. Without `deletedAt: null` the read returns the
    // ACTIVE row and answers 409 to a legitimate re-invitation.
    const departed = await acting('OWNER');
    const leaver = await user();
    const liveRow = await membership({
      organizationId: departed.organizationId,
      userId: leaver.id,
      role: 'MEMBER',
    });
    await owner.membership.update({
      where: { id: liveRow },
      data: { status: 'REMOVED', deletedAt: new Date() },
    });

    const reinvite = await request(server)
      .post(invitesPath(departed.organizationId))
      .set(csrf(departed.actor))
      .send({ email: leaver.email, roleKey: 'MEMBER' });
    expect(reinvite.status).toBe(201);

    // Arm 2 — removed, then re-added, so the LIVE row is physically last. A
    // resolver without the predicate returns the removed row, concludes "not a
    // member", and lets the invitation through when it must be refused.
    await clearRateLimits(harness.redis);
    const rejoined = await acting('OWNER');
    const returner = await user();
    const firstStint = await membership({
      organizationId: rejoined.organizationId,
      userId: returner.id,
      role: 'MEMBER',
    });
    await owner.membership.update({
      where: { id: firstStint },
      data: { status: 'REMOVED', deletedAt: new Date() },
    });
    const secondStint = await membership({
      organizationId: rejoined.organizationId,
      userId: returner.id,
      role: 'MEMBER',
    });
    // The arrangement itself, asserted: the live row must come back last from
    // an unordered scan, or this test is not the guard it claims to be.
    const scanned = await owner.$queryRawUnsafe<{ id: string; deletedAt: Date | null }[]>(
      `SELECT id, "deletedAt" FROM "Membership" WHERE "organizationId" = $1 AND "userId" = $2`,
      rejoined.organizationId,
      returner.id,
    );
    expect(scanned.map((row) => row.id)).toEqual([firstStint, secondStint]);

    const refused = await request(server)
      .post(invitesPath(rejoined.organizationId))
      .set(csrf(rejoined.actor))
      .send({ email: returner.email, roleKey: 'MEMBER' });
    expect(refused.status).toBe(409);
    expect(codeOf(refused.body)).toBe('DUPLICATE_RESOURCE');
  });

  it('answers 404 when the path id is not the session’s active organisation', async () => {
    await clearRateLimits(harness.redis);
    const { actor } = await acting('OWNER');
    const elsewhere = await organization();

    const response = await request(server)
      .post(invitesPath(elsewhere))
      .set(csrf(actor))
      .send({ email: `cross-${unique()}@example.test`, roleKey: 'MEMBER' });

    expect(response.status).toBe(404);
    expect(codeOf(response.body)).toBe('RESOURCE_NOT_FOUND');
  });
});

describe('POST /api/v1/organizations/:id/invitations — two at once', () => {
  it('does not leave two live invitations for one address', async () => {
    // D4's whole reason. Under READ COMMITTED a second transaction's
    // `UPDATE ... WHERE "revokedAt" IS NULL` cannot see the first's uncommitted
    // INSERT, so without the advisory lock neither supersedes the other. What
    // then decides is the partial unique index, which raises P2002 — a 500 on a
    // routine re-invitation. The lock is what turns that into two serialised
    // requests, and the assertion is on BOTH halves: two successes, and exactly
    // one live row.
    //
    // Carry-forward ruling 74: a property about two requests has to be tested
    // with two requests. This is a `Promise.all` rather than a barrier, and the
    // limit of that is stated rather than glossed (ruling 88): it does not
    // FORCE the overlap, so a run where the first commits before the second
    // begins passes for the wrong reason. What makes it worth having is that
    // the failure it guards against is not a timing anomaly but a P2002 that
    // fires whenever the two DO overlap.
    await clearRateLimits(harness.redis);
    const { actor, organizationId } = await acting('OWNER');
    const invitee = `race-${unique()}@example.test`;

    const send = (): Promise<request.Response> =>
      request(server)
        .post(invitesPath(organizationId))
        .set(csrf(actor))
        .send({ email: invitee, roleKey: 'MEMBER' });

    const [a, b] = await Promise.all([send(), send()]);

    expect([a.status, b.status].sort()).toEqual([201, 201]);
    const live = await owner.invitation.findMany({
      where: { organizationId, email: invitee, acceptedAt: null, revokedAt: null },
      select: { id: true },
    });
    expect(live).toHaveLength(1);
    expect(await owner.invitation.count({ where: { organizationId, email: invitee } })).toBe(2);
  });

  it('BLOCKS while another session holds the advisory lock for that (organisation, address)', async () => {
    // THE DETERMINISTIC DETECTOR, AND THE `Promise.all` ABOVE IS NOT ONE.
    //
    // Carry-forward rulings 88, 119 and 120. Deleting `lockInvitationSlot` and
    // re-running the arm above gave **EXIT=0, EXIT=0, EXIT=1** across three
    // full runs of this file — a race test that reports green on a fast enough
    // interleaving, which is ruling 119's defect exactly. This arm is the one
    // that fails every time, because it does not race anything: it takes the
    // lock first and then asks whether the handler waits for it.
    //
    // **Why an advisory blocker rather than a row lock.** Ruling 121: the
    // tenant-scoping extension forces `organizationId` into every `updateMany`
    // payload, so Postgres re-checks the foreign key and takes `FOR KEY SHARE`
    // on the parent row — a `FOR UPDATE` blocker on `Organization` therefore
    // conflicts whether or not the handler locks anything, and the detector
    // passes under its own mutation. `pg_advisory_lock` has no such
    // interaction: the only thing in this codebase that touches this key is
    // `lockInvitationSlot`, and the key is the same string it builds.
    //
    // The blocker is SESSION-level (`pg_advisory_lock`) rather than
    // transaction-level, so it survives the statement that took it and is
    // released explicitly below.
    await clearRateLimits(harness.redis);
    const { actor, organizationId } = await acting('OWNER');
    const invitee = `blocked-${unique()}@example.test`;
    const key = `inv:${organizationId}:${invitee}`;

    // `pg_advisory_lock` returns `void` and `$queryRaw` cannot deserialise
    // that — the same trap `TokenService.issueInTransaction` documents, and it
    // raises AFTER the lock has been taken, so it looks like a SQL mistake
    // while actually holding a lock. Wrapped in a subquery so the result set is
    // a plain `int`. `pg_advisory_unlock` returns `boolean` and needs no wrap.
    await blockerConnection.$queryRaw`SELECT 1 AS taken FROM (SELECT pg_advisory_lock(hashtext(${key}))) AS l`;

    let settled = false;
    const pending = request(server)
      .post(invitesPath(organizationId))
      .set(csrf(actor))
      .send({ email: invitee, roleKey: 'MEMBER' })
      .then((response) => {
        settled = true;
        return response;
      });

    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(
      settled,
      'The invite answered while another session held the advisory lock for its ' +
        '(organisation, address) pair, so `create` never took that lock. Supersede-then-insert ' +
        'is then unsound under concurrency (carry-forward ruling 31), and the partial unique ' +
        'index turns the collision into a P2002 and a 500 rather than into two serialised ' +
        'invitations.',
    ).toBe(false);

    await blockerConnection.$queryRaw`SELECT pg_advisory_unlock(hashtext(${key})) AS released`;

    const response = await pending;
    expect(response.status).toBe(201);
  }, 60_000);

  it('does not take that lock for a DIFFERENT address in the same organisation', async () => {
    // The other direction, and it is what stops the detector above passing
    // because the handler locks something coarse. A per-organisation lock would
    // serialise every invitation a tenant sends; the key is the pair the
    // invariant is about, exactly as `TokenService.issue`'s is.
    await clearRateLimits(harness.redis);
    const { actor, organizationId } = await acting('OWNER');
    const held = `held-${unique()}@example.test`;
    const other = `other-${unique()}@example.test`;

    await blockerConnection.$queryRaw`SELECT 1 AS taken FROM (SELECT pg_advisory_lock(hashtext(${`inv:${organizationId}:${held}`}))) AS l`;
    try {
      const response = await request(server)
        .post(invitesPath(organizationId))
        .set(csrf(actor))
        .send({ email: other, roleKey: 'MEMBER' });
      expect(response.status).toBe(201);
    } finally {
      await blockerConnection.$queryRaw`SELECT pg_advisory_unlock(hashtext(${`inv:${organizationId}:${held}`})) AS released`;
    }
  }, 60_000);
});

describe('GET /api/v1/organizations/:id/invitations', () => {
  it('lists the organisation’s invitations newest first, and never a token', async () => {
    await clearRateLimits(harness.redis);
    const { actor, organizationId } = await acting('OWNER');
    const older = await invitation({
      organizationId,
      email: `older-${unique()}@example.test`,
      invitedByUserId: actor.userId,
    });
    const newer = await invitation({
      organizationId,
      email: `newer-${unique()}@example.test`,
      invitedByUserId: actor.userId,
    });

    const response = await request(server).get(invitesPath(organizationId)).set(csrf(actor));

    expect(response.status).toBe(200);
    const body = invitationCollectionSchema.parse(response.body);
    expect(body.data.map((row) => row.id)).toEqual([newer, older]);
    expect(body.pagination.hasMore).toBe(false);
    expect(body.pagination.limit).toBe(50);

    // The raw payload, for the reason the create test gives: the schema strips
    // an unknown key, so parsing first would hide exactly the leak this
    // asserts against. The fixtures' hashes are `sha256('fixture-<id>')`, so a
    // handler that selected the column would put a real value here.
    const raw = JSON.stringify(response.body);
    expect(raw).not.toContain('token');
    expect(raw).not.toContain(hashSecretToken(`fixture-${older}`));
  });

  it('includes accepted and revoked invitations, so the trail is complete', async () => {
    // The decision recorded in `InvitationService.list`: every invitation, not
    // only the live ones, because `invitationResponseSchema` publishes
    // `acceptedAt` and `revokedAt` and a client filters. If that is ever
    // narrowed, this test is where the decision is stated.
    await clearRateLimits(harness.redis);
    const { actor, organizationId } = await acting('OWNER');
    const accepted = await invitation({
      organizationId,
      email: `accepted-${unique()}@example.test`,
      invitedByUserId: actor.userId,
      acceptedAt: new Date(),
    });
    const revoked = await invitation({
      organizationId,
      email: `revoked-${unique()}@example.test`,
      invitedByUserId: actor.userId,
      revokedAt: new Date(),
    });

    const response = await request(server).get(invitesPath(organizationId)).set(csrf(actor));
    const body = invitationCollectionSchema.parse(response.body);
    expect(body.data.map((row) => row.id).sort()).toEqual([accepted, revoked].sort());
    expect(body.data.find((row) => row.id === accepted)?.acceptedAt).not.toBeNull();
    expect(body.data.find((row) => row.id === revoked)?.revokedAt).not.toBeNull();
  });

  it('pages with a cursor and clamps a limit above the maximum rather than refusing it', async () => {
    await clearRateLimits(harness.redis);
    const { actor, organizationId } = await acting('OWNER');
    for (let i = 0; i < 3; i += 1) {
      await invitation({
        organizationId,
        email: `page-${String(i)}-${unique()}@example.test`,
        invitedByUserId: actor.userId,
      });
    }

    const first = await request(server)
      .get(`${invitesPath(organizationId)}?limit=2`)
      .set(csrf(actor));
    const page = invitationCollectionSchema.parse(first.body);
    expect(page.data).toHaveLength(2);
    expect(page.pagination.hasMore).toBe(true);
    expect(page.pagination.nextCursor).not.toBeNull();

    const second = await request(server)
      .get(`${invitesPath(organizationId)}?limit=2&cursor=${String(page.pagination.nextCursor)}`)
      .set(csrf(actor));
    const rest = invitationCollectionSchema.parse(second.body);
    expect(rest.data).toHaveLength(1);
    expect(rest.pagination.hasMore).toBe(false);
    // No overlap between the pages — the `(createdAt, id)` tie-breaker is what
    // makes that true for rows one transaction could have written together.
    const ids = new Set([...page.data, ...rest.data].map((row) => row.id));
    expect(ids.size).toBe(3);

    const clamped = await request(server)
      .get(`${invitesPath(organizationId)}?limit=500`)
      .set(csrf(actor));
    expect(clamped.status).toBe(200);
    expect(invitationCollectionSchema.parse(clamped.body).pagination.limit).toBe(100);
  });

  it('CROSS-TENANT — shows nothing of another organisation, and 404s its path id', async () => {
    await clearRateLimits(harness.redis);
    const tenantA = await acting('OWNER');
    const tenantB = await acting('OWNER');
    const theirs = await invitation({
      organizationId: tenantB.organizationId,
      email: `theirs-${unique()}@example.test`,
      invitedByUserId: tenantB.actor.userId,
    });

    const own = await request(server)
      .get(invitesPath(tenantA.organizationId))
      .set(csrf(tenantA.actor));
    expect(own.status).toBe(200);
    expect(invitationCollectionSchema.parse(own.body).data.map((row) => row.id)).not.toContain(
      theirs,
    );

    const theirPath = await request(server)
      .get(invitesPath(tenantB.organizationId))
      .set(csrf(tenantA.actor));
    expect(theirPath.status).toBe(404);
    expect(codeOf(theirPath.body)).toBe('RESOURCE_NOT_FOUND');
  });
});

describe('DELETE /api/v1/organizations/:id/invitations/:invitationId', () => {
  it('revokes a pending invitation, with the audit row in the same transaction', async () => {
    await clearRateLimits(harness.redis);
    const { actor, organizationId } = await acting('OWNER');
    const invitee = `revoke-${unique()}@example.test`;
    const target = await invitation({
      organizationId,
      email: invitee,
      invitedByUserId: actor.userId,
    });

    const response = await request(server)
      .delete(`${invitesPath(organizationId)}/${target}`)
      .set(csrf(actor));

    expect(response.status).toBe(204);
    expect(response.body).toEqual({});
    expect(
      (
        await owner.invitation.findUniqueOrThrow({
          where: { id: target },
          select: { revokedAt: true },
        })
      ).revokedAt,
    ).not.toBeNull();

    const events = await owner.auditEvent.findMany({
      where: { organizationId, action: 'INVITATION_REVOKED' },
      select: { resourceType: true, resourceId: true, actorId: true, metadata: true },
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.resourceType).toBe('Invitation');
    expect(events[0]?.resourceId).toBe(target);
    expect(events[0]?.actorId).toBe(actor.userId);
    expect(events[0]?.metadata).toMatchObject({ email: invitee, roleKey: 'MEMBER' });
  });

  it('answers 404 to an invitation that is already revoked, already accepted, or absent', async () => {
    await clearRateLimits(harness.redis);
    const { actor, organizationId } = await acting('OWNER');
    const alreadyRevoked = await invitation({
      organizationId,
      email: `gone-${unique()}@example.test`,
      invitedByUserId: actor.userId,
      revokedAt: new Date(),
    });
    const alreadyAccepted = await invitation({
      organizationId,
      email: `joined-${unique()}@example.test`,
      invitedByUserId: actor.userId,
      acceptedAt: new Date(),
    });

    for (const id of [alreadyRevoked, alreadyAccepted, newId('inv')]) {
      const response = await request(server)
        .delete(`${invitesPath(organizationId)}/${id}`)
        .set(csrf(actor));
      expect(response.status, id).toBe(404);
      expect(codeOf(response.body)).toBe('RESOURCE_NOT_FOUND');
    }

    // Nothing was written for any of the three refusals.
    expect(
      await owner.auditEvent.count({ where: { organizationId, action: 'INVITATION_REVOKED' } }),
    ).toBe(0);
  });

  it('CROSS-TENANT — Tenant A gets 404 for Tenant B’s invitation id, and it survives', async () => {
    // `CLAUDE.md`'s mandatory cross-tenant test, on the verb that would do
    // damage. 404 and never 403: a 403 confirms the resource exists
    // (`security/authorization.md` §6), and the refusal must be byte-identical
    // to the one an id that does not exist gets.
    await clearRateLimits(harness.redis);
    const tenantA = await acting('OWNER');
    const tenantB = await acting('OWNER');
    const theirs = await invitation({
      organizationId: tenantB.organizationId,
      email: `victim-${unique()}@example.test`,
      invitedByUserId: tenantB.actor.userId,
    });

    // Their id under A's own path — the shape an attacker actually has, since
    // B's path id is refused by the tenant check before the handler runs.
    const response = await request(server)
      .delete(`${invitesPath(tenantA.organizationId)}/${theirs}`)
      .set(csrf(tenantA.actor));
    expect(response.status).toBe(404);
    expect(codeOf(response.body)).toBe('RESOURCE_NOT_FOUND');

    const absent = await request(server)
      .delete(`${invitesPath(tenantA.organizationId)}/${newId('inv')}`)
      .set(csrf(tenantA.actor));
    expect(response.body).toMatchObject({
      error: { code: codeOf(absent.body), message: envelopeOf(absent.body).error.message },
    });

    expect(
      (
        await owner.invitation.findUniqueOrThrow({
          where: { id: theirs },
          select: { revokedAt: true },
        })
      ).revokedAt,
    ).toBeNull();
  });

  it('does not write two audit rows when two revocations race one invitation', async () => {
    // The conditional `updateMany` is what decides, not the read above it: of
    // two requests the database lets exactly one write `revokedAt`, and the
    // other re-evaluates `revokedAt IS NULL` against the committed row and
    // reports `count: 0`. Replace it with a `SELECT` then an `update` and this
    // goes to two 204s and two audit rows for one revocation.
    await clearRateLimits(harness.redis);
    const { actor, organizationId } = await acting('OWNER');
    const target = await invitation({
      organizationId,
      email: `double-${unique()}@example.test`,
      invitedByUserId: actor.userId,
    });

    const send = (): Promise<request.Response> =>
      request(server)
        .delete(`${invitesPath(organizationId)}/${target}`)
        .set(csrf(actor));
    const [a, b] = await Promise.all([send(), send()]);

    expect([a.status, b.status].sort()).toEqual([204, 404]);
    expect(
      await owner.auditEvent.count({ where: { organizationId, action: 'INVITATION_REVOKED' } }),
    ).toBe(1);
  });
});
