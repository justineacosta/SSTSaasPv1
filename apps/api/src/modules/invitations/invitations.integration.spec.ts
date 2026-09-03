import type { Server } from 'node:http';
import {
  errorEnvelopeSchema,
  invitationCollectionSchema,
  invitationResponseSchema,
  membershipResponseSchema,
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
 * ALL FOUR INVITATION ROUTES, AGAINST REAL ROW-LEVEL SECURITY, THE REAL GUARD
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
 * # Acceptance is here, and it was not
 *
 * `POST /api/v1/invitations/accept` was blocked when this file was first
 * written: the acceptor is a member of nothing, so no organisation resolves,
 * and `Invitation` carries `FORCE ROW LEVEL SECURITY` keyed on
 * `organizationId` — the handler could not read the invitation its own token
 * named. ADR-0022's `SECURITY DEFINER` lookup
 * (`20260904020000_invitation_lookup_function`) answers that one question and
 * nothing else, and the three tests this file's docblock used to say were
 * unwritten are now the last two blocks: a different signed-in user cannot
 * consume somebody else's invitation, two concurrent accepts yield exactly one
 * membership, and invite → accept → remove → invite → accept runs end to end.
 */

const envelopeOf = (body: unknown): ErrorEnvelope => errorEnvelopeSchema.parse(body);
const codeOf = (body: unknown): string => envelopeOf(body).error.code;
/**
 * Everything about a refusal that a caller could learn something from.
 *
 * `error.requestId` is a fresh ULID per request, so a whole-body `toEqual` can
 * never hold between two calls; the code and the message are the parts that
 * would make a refusal an oracle, and they are what "byte-identical" means for
 * the assertions below.
 */
const refusalOf = (body: unknown): { code: string; message: string } => {
  const { code, message } = envelopeOf(body).error;
  return { code, message };
};

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
 * The raw token of a fixture invitation, derived from its id.
 *
 * A real invitation's token exists only in the email — `create` returns it to
 * nobody and the row holds a SHA-256 of it — so the acceptance tests read it out
 * of `harness.sent`. A row written straight into the table has no email, so its
 * token is derived instead. Deliberately NOT the shape `mintSecretToken`
 * produces, so a fixture token can never be mistaken for a real credential in a
 * log or a failure message.
 */
const fixtureTokenFor = (invitationId: string): string => `fixture-${invitationId}`;

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
      tokenHash: hashSecretToken(fixtureTokenFor(id)),
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

  it('F-1 — revoking an EXPIRED invitation answers 204 and writes the audit row', async () => {
    // **The docblock on `revoke` used to claim 404 here, and the code has always
    // answered 204.** The review measured it with a probe; the ruling is that
    // the code is right and the prose was wrong, and this test is what stops the
    // pair drifting apart again in either direction.
    //
    // Why 204 is right: `list` applies no liveness filter, so this row is in the
    // list a holder of `organization.manage_members` can read, and telling that
    // caller 404 for a row they can see is two contradictory answers about one
    // row. The write also has a real effect — `revokedAt` takes the row out of
    // `Invitation_organizationId_email_live_key`'s live set and frees the
    // `(organizationId, email)` slot immediately — so "there is nothing to
    // revoke" was false.
    await clearRateLimits(harness.redis);
    const { actor, organizationId } = await acting('OWNER');
    const invitee = `expired-revoke-${unique()}@example.test`;
    const target = await invitation({
      organizationId,
      email: invitee,
      invitedByUserId: actor.userId,
      expiresAt: new Date(Date.now() - 60_000),
    });

    // The premise: it really is visible in the list, which is the argument.
    const listed = await request(server).get(invitesPath(organizationId)).set(csrf(actor));
    expect(listed.status).toBe(200);
    expect(invitationCollectionSchema.parse(listed.body).data.map((row) => row.id)).toContain(
      target,
    );

    const response = await request(server)
      .delete(`${invitesPath(organizationId)}/${target}`)
      .set(csrf(actor));

    expect(response.status).toBe(204);
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
      select: { resourceId: true },
    });
    expect(events.map((event) => event.resourceId)).toEqual([target]);

    // And it is idempotent in the only sense that matters: a second revocation
    // of the now-revoked row is the ordinary 404, and no second audit row.
    const again = await request(server)
      .delete(`${invitesPath(organizationId)}/${target}`)
      .set(csrf(actor));
    expect(again.status).toBe(404);
    expect(
      await owner.auditEvent.count({ where: { organizationId, action: 'INVITATION_REVOKED' } }),
    ).toBe(1);
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

/**
 * THE ACCEPTANCE PATH, END TO END, AGAINST REAL ROW-LEVEL SECURITY.
 *
 * This is the block whose absence the file docblock used to explain. Every test
 * below drives the real route through the real guard chain as `sentinel_app`,
 * so the `SECURITY DEFINER` lookup, the tenant transaction it opens, and the
 * RLS the handler then works under are all live rather than described.
 *
 * **The token comes out of the sent message.** `create` returns no token by
 * design and the row holds only a SHA-256 of it, so the only honest way to
 * accept an invitation the API issued is to read the link the API emailed —
 * which is also the journey a real invitee takes. The fixtures that write a row
 * directly use `fixtureTokenFor`, for the states `create` cannot produce.
 */
const acceptPath = '/api/v1/invitations/accept';

/** The raw token out of the emailed link, which is the only place it exists. */
function tokenFromMailTo(address: string): string {
  const message = harness.sent.filter((mail) => mail.to === address).at(-1);
  const match = /[?&]token=([A-Za-z0-9_-]+)/.exec(message?.text ?? '');
  if (match?.[1] === undefined) {
    throw new Error(
      `No invitation link was sent to ${address}. Sent: ${String(harness.sent.length)}`,
    );
  }
  return match[1];
}

/** Invite `email` at `role` through the real endpoint, and return its raw token. */
async function inviteAndCaptureToken(
  actor: Actor,
  organizationId: string,
  email: string,
  role: SystemRole = 'MEMBER',
): Promise<string> {
  const response = await request(server)
    .post(invitesPath(organizationId))
    .set(csrf(actor))
    .send({ email, roleKey: role });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return tokenFromMailTo(email);
}

/** A signed-in account that is a member of nothing, which is every acceptor. */
async function acceptor(options: { emailVerified?: boolean } = {}): Promise<{
  actor: Actor;
  email: string;
}> {
  const account = await user(options);
  const actor = await sessionFor(account.id, null);
  return { actor, email: account.email };
}

describe('POST /api/v1/invitations/accept', () => {
  it('creates the membership, consumes the invitation, and audits both in one transaction', async () => {
    await clearRateLimits(harness.redis);
    const inviter = await acting('OWNER');
    const invitee = await acceptor();
    const token = await inviteAndCaptureToken(
      inviter.actor,
      inviter.organizationId,
      invitee.email,
      'ADMIN',
    );

    const response = await request(server)
      .post(acceptPath)
      .set(csrf(invitee.actor))
      .send({ token });

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const body = membershipResponseSchema.parse(response.body);
    expect(body.organizationId).toBe(inviter.organizationId);
    expect(body.user.id).toBe(invitee.actor.userId);
    expect(body.user.email).toBe(invitee.email);
    expect(body.roleKey).toBe('ADMIN');
    expect(body.status).toBe('ACTIVE');

    // THE RAW BODY, NOT THE PARSED ONE. `membershipResponseSchema` is not
    // `.strict()`, so parsing would strip a token the handler had leaked and
    // the assertion would pass over the defect it exists to catch.
    const raw = JSON.stringify(response.body);
    expect(raw).not.toContain(token);
    expect(raw).not.toContain('token');

    // The invitation is consumed, not deleted: the trail of who was invited and
    // what became of it is the reason the row is retained.
    const consumed = await owner.invitation.findFirstOrThrow({
      where: { organizationId: inviter.organizationId, email: invitee.email },
      select: { id: true, acceptedAt: true, revokedAt: true },
    });
    expect(consumed.acceptedAt).not.toBeNull();
    expect(consumed.revokedAt).toBeNull();

    const stored = await owner.membership.findUniqueOrThrow({
      where: { id: body.id },
      select: { status: true, deletedAt: true, organizationId: true },
    });
    // Ruling 10: the two columns are one fact and both were written.
    expect(stored).toMatchObject({
      status: 'ACTIVE',
      deletedAt: null,
      organizationId: inviter.organizationId,
    });

    const events = await owner.auditEvent.findMany({
      where: { organizationId: inviter.organizationId, action: 'INVITATION_ACCEPTED' },
      select: { resourceType: true, resourceId: true, actorId: true, metadata: true },
    });
    expect(events).toHaveLength(1);
    // The INVITATION, not the membership — `audit.actions.ts` says why, and the
    // membership id is in the metadata for the join.
    expect(events[0]?.resourceType).toBe('Invitation');
    expect(events[0]?.resourceId).toBe(consumed.id);
    expect(events[0]?.actorId).toBe(invitee.actor.userId);
    expect(events[0]?.metadata).toMatchObject({
      membershipId: body.id,
      roleKey: 'ADMIN',
      memberUserId: invitee.actor.userId,
    });
    // Ruling 38, asserted rather than assumed.
    expect(JSON.stringify(events[0]?.metadata)).not.toContain(token);

    // F-3's consequence, asserted so the reasoning is not merely written down:
    // this route carries `generalSession` and NOT `invitations`. A
    // `perOrganization` class here would have answered 429 to this very
    // request, because no tenant resolves before the handler runs.
    expect(response.status).not.toBe(429);
  });

  it('D11 / CROSS-TENANT — a different signed-in user gets the same bytes as an unknown token, and writes nothing', async () => {
    // **THE INTERESTING ATTACK, NOT THE HAPPY PATH** — the plan's own words.
    // The invited address is compared to the AUTHENTICATED user's and never to
    // a body field; `acceptInvitationRequestSchema` has no field for one.
    //
    // This is also this route's cross-tenant test (`CLAUDE.md`), in the only
    // shape it can take: there is no path id to point at another organisation,
    // so the attacker's handle is somebody else's token. The stranger is a
    // real, live `OWNER` of their own organisation, so nothing about their
    // session is deficient — the only thing wrong is that the invitation was
    // not sent to them.
    await clearRateLimits(harness.redis);
    const tenantB = await acting('OWNER');
    const invitee = await acceptor();
    const token = await inviteAndCaptureToken(
      tenantB.actor,
      tenantB.organizationId,
      invitee.email,
      'OWNER',
    );
    const stranger = await acting('OWNER');

    const refused = await request(server)
      .post(acceptPath)
      .set(csrf(stranger.actor))
      .send({ token });

    const unknown = await request(server)
      .post(acceptPath)
      .set(csrf(stranger.actor))
      .send({ token: mintSecretToken().token });

    expect(refused.status).toBe(422);
    expect(codeOf(refused.body)).toBe('TOKEN_INVALID');
    // BYTE-IDENTICAL, not merely the same status. A different message would
    // make this endpoint an oracle for "does this token exist", which is the
    // one bit the whole design is spent on denying.
    expect(refused.status).toBe(unknown.status);
    expect(refusalOf(refused.body)).toEqual(refusalOf(unknown.body));

    // Nothing was written in either organisation, and B's invitation is still
    // there for the person it was actually sent to.
    expect(
      await owner.membership.count({
        where: { organizationId: tenantB.organizationId, userId: stranger.actor.userId },
      }),
    ).toBe(0);
    expect(
      await owner.membership.count({
        where: { organizationId: stranger.organizationId, userId: stranger.actor.userId },
      }),
    ).toBe(1);
    const untouched = await owner.invitation.findFirstOrThrow({
      where: { organizationId: tenantB.organizationId, email: invitee.email },
      select: { acceptedAt: true, revokedAt: true },
    });
    expect(untouched).toEqual({ acceptedAt: null, revokedAt: null });
    expect(
      await owner.auditEvent.count({
        where: { organizationId: tenantB.organizationId, action: 'INVITATION_ACCEPTED' },
      }),
    ).toBe(0);

    // And the person it WAS sent to can still use it, which is what proves the
    // refusal above was about the address and not about the token's state.
    const accepted = await request(server)
      .post(acceptPath)
      .set(csrf(invitee.actor))
      .send({ token });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
  });

  it('D2 — an UNVERIFIED account may accept, and that is the whole point of the omission', async () => {
    // `security/authentication.md` §6 lists creating organisations, inviting and
    // scanning as what an unverified account cannot do. Accepting is not in that
    // list and must not be added: the token was delivered to the address, which
    // is the same proof of address control the verification guard exists to
    // obtain. Gating this route would lock out exactly the person invited.
    //
    // The other half — that `create` DOES refuse an unverified caller — is
    // asserted above, so this pair is the split rather than a single direction.
    await clearRateLimits(harness.redis);
    const inviter = await acting('OWNER');
    const invitee = await acceptor({ emailVerified: false });
    const token = await inviteAndCaptureToken(inviter.actor, inviter.organizationId, invitee.email);

    const response = await request(server)
      .post(acceptPath)
      .set(csrf(invitee.actor))
      .send({ token });

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(
      await owner.user.findUniqueOrThrow({
        where: { id: invitee.actor.userId },
        select: { emailVerifiedAt: true },
      }),
    ).toEqual({ emailVerifiedAt: null });
  });

  it('refuses a revoked, an expired and an already-accepted invitation with one 422', async () => {
    // Three states `create` cannot produce, written straight into the table.
    // One code and one message for all of them, per `error-codes.ts`: splitting
    // them would tell a caller which of the four happened, and "expired"
    // confirms the token once existed.
    await clearRateLimits(harness.redis);
    const inviter = await acting('OWNER');

    const cases: { label: string; token: string; actor: Actor }[] = [];
    for (const state of ['revoked', 'expired', 'accepted'] as const) {
      const account = await acceptor();
      const id = await invitation({
        organizationId: inviter.organizationId,
        email: account.email,
        invitedByUserId: inviter.actor.userId,
        ...(state === 'revoked' ? { revokedAt: new Date() } : {}),
        ...(state === 'expired' ? { expiresAt: new Date(Date.now() - 60_000) } : {}),
        ...(state === 'accepted' ? { acceptedAt: new Date() } : {}),
      });
      cases.push({ label: state, token: fixtureTokenFor(id), actor: account.actor });
    }

    const bodies: { code: string; message: string }[] = [];
    for (const probe of cases) {
      const response = await request(server)
        .post(acceptPath)
        .set(csrf(probe.actor))
        .send({ token: probe.token });
      expect(response.status, probe.label).toBe(422);
      expect(codeOf(response.body), probe.label).toBe('TOKEN_INVALID');
      bodies.push(refusalOf(response.body));
      expect(
        await owner.membership.count({
          where: { organizationId: inviter.organizationId, userId: probe.actor.userId },
        }),
        probe.label,
      ).toBe(0);
    }
    // All three answers identical to each other, which is the property the one
    // shared error class exists to give.
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);

    expect(
      await owner.auditEvent.count({
        where: { organizationId: inviter.organizationId, action: 'INVITATION_ACCEPTED' },
      }),
    ).toBe(0);
  });

  it('cannot be accepted twice, sequentially, with the second answering the same 422', async () => {
    await clearRateLimits(harness.redis);
    const inviter = await acting('OWNER');
    const invitee = await acceptor();
    const token = await inviteAndCaptureToken(inviter.actor, inviter.organizationId, invitee.email);

    const first = await request(server).post(acceptPath).set(csrf(invitee.actor)).send({ token });
    const second = await request(server).post(acceptPath).set(csrf(invitee.actor)).send({ token });

    expect(first.status).toBe(201);
    expect(second.status).toBe(422);
    expect(codeOf(second.body)).toBe('TOKEN_INVALID');
    expect(
      await owner.membership.count({
        where: { organizationId: inviter.organizationId, userId: invitee.actor.userId },
      }),
    ).toBe(1);
    expect(
      await owner.auditEvent.count({
        where: { organizationId: inviter.organizationId, action: 'INVITATION_ACCEPTED' },
      }),
    ).toBe(1);
  });

  it('F-9 / RULING 99+100 — the membership pair is guarded on the ACCEPT side, arranged to lose', async () => {
    // The accept-side twin of the create-side test above, and the test the F-9
    // comment on `assertUserIsNotAlreadyAMember` names.
    //
    // **Neither term of `{ status: 'ACTIVE', deletedAt: null }` can be guarded
    // alone**, because `Membership_status_deletedAt_agree_check` makes them
    // equivalent by construction — the reviewer measured both single-term
    // mutations GREEN and only the pair RED. So this test removes the ambiguity
    // the only way it can be removed: it asserts both directions of the
    // predicate, so deleting BOTH terms turns it red twice.
    //
    // Ruling 100 binds the arrangement: the live row is written LAST, so a
    // resolver without the predicate seq-scans the removed row first, concludes
    // "not a member", and lets the second membership through.
    await clearRateLimits(harness.redis);
    const home = await acting('OWNER');

    // Arm 1 — a REMOVED member may accept a fresh invitation. Without the
    // predicate the removed row is found, the 409 fires, and somebody who
    // genuinely left can never be re-admitted.
    const returner = await acceptor();
    const oldRow = await membership({
      organizationId: home.organizationId,
      userId: returner.actor.userId,
      role: 'MEMBER',
      status: 'REMOVED',
    });
    const readmit = await inviteAndCaptureToken(home.actor, home.organizationId, returner.email);
    const rejoined = await request(server)
      .post(acceptPath)
      .set(csrf(returner.actor))
      .send({ token: readmit });
    expect(rejoined.status, JSON.stringify(rejoined.body)).toBe(201);

    // The arrangement itself, asserted: the live row must come back LAST from
    // an unordered scan, or this test is not the guard it claims to be.
    const scanned = await owner.$queryRawUnsafe<{ id: string }[]>(
      `SELECT id FROM "Membership" WHERE "organizationId" = $1 AND "userId" = $2`,
      home.organizationId,
      returner.actor.userId,
    );
    expect(scanned.map((row) => row.id)).toEqual([
      oldRow,
      membershipResponseSchema.parse(rejoined.body).id,
    ]);

    // Arm 2 — with the live row physically last, a second invitation to the
    // same person must be refused 409 rather than minting a duplicate. Written
    // straight into the table because `create` refuses to issue it (which is
    // itself the create-side half of this guard).
    const duplicate = await invitation({
      organizationId: home.organizationId,
      email: returner.email,
      invitedByUserId: home.actor.userId,
    });
    const refused = await request(server)
      .post(acceptPath)
      .set(csrf(returner.actor))
      .send({ token: fixtureTokenFor(duplicate) });
    expect(refused.status).toBe(409);
    expect(codeOf(refused.body)).toBe('DUPLICATE_RESOURCE');
    // A 409 rather than a P2002 and a 500: the partial unique index
    // `Membership_organizationId_userId_active_key` is the second line, not the
    // first.
    expect(
      await owner.membership.count({
        where: {
          organizationId: home.organizationId,
          userId: returner.actor.userId,
          deletedAt: null,
        },
      }),
    ).toBe(1);
  });

  it('THE RE-INVITE JOURNEY — invite, accept, remove, invite, accept: two rows, exactly one live', async () => {
    // The case Task 1's partial index and this task's partial index exist for,
    // and the one the plan assigns to Task 15. Driven end to end through three
    // real endpoints, because the property is about what they do to each
    // other's rows and no unit test can see that.
    await clearRateLimits(harness.redis);
    const home = await acting('OWNER');
    const member = await acceptor();

    const firstToken = await inviteAndCaptureToken(home.actor, home.organizationId, member.email);
    const firstAccept = await request(server)
      .post(acceptPath)
      .set(csrf(member.actor))
      .send({ token: firstToken });
    expect(firstAccept.status, JSON.stringify(firstAccept.body)).toBe(201);
    const firstMembership = membershipResponseSchema.parse(firstAccept.body).id;

    // Task 14's endpoint, not a direct write: the journey has to pass through
    // the soft delete the way a real removal does, or the partial index is
    // never put under the pressure this test is about.
    await clearRateLimits(harness.redis);
    const removed = await request(server)
      .delete(`/api/v1/organizations/${home.organizationId}/members/${firstMembership}`)
      .set(csrf(home.actor));
    expect(removed.status, JSON.stringify(removed.body)).toBe(204);

    await clearRateLimits(harness.redis);
    const secondToken = await inviteAndCaptureToken(
      home.actor,
      home.organizationId,
      member.email,
      'ADMIN',
    );
    const secondAccept = await request(server)
      .post(acceptPath)
      .set(csrf(member.actor))
      .send({ token: secondToken });
    expect(secondAccept.status, JSON.stringify(secondAccept.body)).toBe(201);
    const secondMembership = membershipResponseSchema.parse(secondAccept.body);
    expect(secondMembership.id).not.toBe(firstMembership);
    expect(secondMembership.roleKey).toBe('ADMIN');

    // BOTH rows exist and exactly one is live — the whole point of a partial
    // unique index rather than a delete.
    const rows = await owner.membership.findMany({
      where: { organizationId: home.organizationId, userId: member.actor.userId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, status: true, deletedAt: true },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: firstMembership, status: 'REMOVED' });
    expect(rows[0]?.deletedAt).not.toBeNull();
    expect(rows[1]).toMatchObject({
      id: secondMembership.id,
      status: 'ACTIVE',
      deletedAt: null,
    });

    // And both invitations were consumed rather than one superseding the other.
    const invitations = await owner.invitation.findMany({
      where: { organizationId: home.organizationId, email: member.email },
      select: { acceptedAt: true, revokedAt: true },
    });
    expect(invitations).toHaveLength(2);
    expect(invitations.every((row) => row.acceptedAt !== null && row.revokedAt === null)).toBe(
      true,
    );
  });
});

describe('POST /api/v1/invitations/accept — concurrency and D9', () => {
  /**
   * THE BLOCKER MODE IS THE MEASUREMENT, NOT A DETAIL. Carry-forward ruling 121.
   *
   * `lockOrganization` takes `SELECT ... FOR UPDATE` on the tenant root. A
   * `FOR UPDATE` blocker would be useless as a detector: the tenant-scoping
   * extension forces `organizationId` into every write payload, so Postgres
   * re-checks the foreign key and takes `FOR KEY SHARE` on the `Organization`
   * row — which conflicts with `FOR UPDATE` whether or not the handler locks
   * anything, and the detector would pass under its own mutation.
   *
   * `FOR NO KEY UPDATE` is the mode that conflicts with the handler's
   * `FOR UPDATE` and NOT with the foreign key's `FOR KEY SHARE`. So this
   * blocker holds a request that takes the organisation lock and lets one that
   * does not through — which is exactly what a detector has to do.
   *
   * It is an interactive transaction rather than a bare statement because a row
   * lock lives for the transaction that took it, and Prisma guarantees one
   * connection for the duration of `$transaction`. `set_config` first, because
   * this client connects as `sentinel_app` and `Organization` carries FORCE RLS
   * — without it the SELECT returns no rows and locks nothing, which is a
   * blocker that silently does not block.
   */
  async function whileOrganizationRowIsLocked<T>(
    organizationId: string,
    body: (release: () => void) => Promise<T>,
  ): Promise<T> {
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: (() => void) | undefined;
    const taken = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const blocker = blockerConnection.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT set_config('app.organization_id', ${organizationId}, true) AS scoped`;
        const rows = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM "Organization" WHERE id = ${organizationId} FOR NO KEY UPDATE
        `;
        expect(
          rows,
          'The blocker locked no row, so every assertion below would pass vacuously. RLS ' +
            'refused the SELECT, or the organisation does not exist.',
        ).toHaveLength(1);
        locked?.();
        await held;
      },
      { timeout: 120_000, maxWait: 30_000 },
    );
    // The lock must be HELD before the body issues a request, or a fast request
    // slips past and the test proves nothing.
    await taken;
    try {
      // **The body releases, not this `finally`.** The requests the body awaits
      // are the ones parked on this lock, so a helper that released only after
      // the body returned would deadlock on itself — measured, at a 120s test
      // timeout, before the callback was threaded through.
      return await body(() => release?.());
    } finally {
      release?.();
      await blocker;
    }
  }

  it('D8 — two accepts released from one lock at the same instant yield exactly one membership', async () => {
    // **NOT a `Promise.all` race.** Ruling 119, and M1 measured the create-side
    // `Promise.all` arm green on 2 of 3 runs with the lock deleted: a race test
    // that reports green on a fast enough interleaving proves nothing. Here both
    // requests are parked on the SAME organisation row lock, so both
    // transactions are provably open and overlapping before either can proceed,
    // and releasing the blocker starts them together. What decides afterwards is
    // the conditional consume and the organisation lock, in that order.
    await clearRateLimits(harness.redis);
    const inviter = await acting('OWNER');
    const invitee = await acceptor();
    const token = await inviteAndCaptureToken(inviter.actor, inviter.organizationId, invitee.email);

    const send = (): Promise<request.Response> =>
      request(server).post(acceptPath).set(csrf(invitee.actor)).send({ token });

    const [a, b] = await whileOrganizationRowIsLocked(inviter.organizationId, async (release) => {
      const first = send();
      const second = send();
      // Long enough for both to have reached `lockOrganization` and parked.
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      release();
      return Promise.all([first, second]);
    });

    // One membership, and the loser is refused with the ordinary
    // not-redeemable answer rather than a 500 from a P2002.
    expect([a.status, b.status].sort()).toEqual([201, 422]);
    // `response.body` is `any`, so it is narrowed by the envelope parser rather
    // than assigned through an intermediate — `codeOf` parses it.
    expect(codeOf(a.status === 422 ? a.body : b.body)).toBe('TOKEN_INVALID');
    expect(
      await owner.membership.count({
        where: { organizationId: inviter.organizationId, userId: invitee.actor.userId },
      }),
    ).toBe(1);
    expect(
      await owner.auditEvent.count({
        where: { organizationId: inviter.organizationId, action: 'INVITATION_ACCEPTED' },
      }),
    ).toBe(1);
  }, 120_000);

  it('BLOCKS while another session holds FOR NO KEY UPDATE on the organisation row', async () => {
    // THE DETERMINISTIC DETECTOR FOR `lockOrganization` ON THIS PATH. The arm
    // above would still pass if acceptance skipped the lock — the conditional
    // consume alone would keep the membership count at one — so the lock needs
    // a mutation of its own (ruling 120: a lock needs a detector per path that
    // takes it, not one per invariant it protects).
    await clearRateLimits(harness.redis);
    const inviter = await acting('OWNER');
    const invitee = await acceptor();
    const token = await inviteAndCaptureToken(inviter.actor, inviter.organizationId, invitee.email);

    let settled = false;
    const response = await whileOrganizationRowIsLocked(inviter.organizationId, async (release) => {
      const pending = request(server)
        .post(acceptPath)
        .set(csrf(invitee.actor))
        .send({ token })
        .then((answer) => {
          settled = true;
          return answer;
        });
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(
        settled,
        'The accept answered while another session held FOR NO KEY UPDATE on the organisation ' +
          'row, so `accept` never took `lockOrganization`. Acceptance creates a Membership and ' +
          'therefore changes the live owner count, so a writer outside that serialisation ' +
          'reopens the last-owner race for the two writers that are inside it.',
      ).toBe(false);
      release();
      return pending;
    });

    expect(response.status, JSON.stringify(response.body)).toBe(201);
  }, 120_000);

  it('D9 — a revoke that commits between the read and the consume leaves NO membership', async () => {
    // **RULING 122'S SHAPE, MEASURED RATHER THAN ARGUED.** "The endpoint checks
    // first" is the reasoning rulings 82 and 122 both struck down, so the
    // question is what happens when the fact moves AFTER the check.
    //
    // The interleaving is arranged, not hoped for. A second connection updates
    // the invitation row and holds the transaction open. Postgres readers do
    // not block on writers, so the accept's `findFirst` sees the pre-update
    // snapshot and judges the invitation LIVE — the check passes. Its
    // conditional `updateMany` then blocks on the row lock. Releasing the
    // revocation lets it re-evaluate `acceptedAt IS NULL AND revokedAt IS NULL`
    // against the COMMITTED row, match nothing, and refuse.
    //
    // A `SELECT` followed by an unconditional `update` passes every sequential
    // test in this file and fails here with a membership standing for an
    // invitation that was revoked before it was consumed.
    await clearRateLimits(harness.redis);
    const inviter = await acting('OWNER');
    const invitee = await acceptor();
    const token = await inviteAndCaptureToken(inviter.actor, inviter.organizationId, invitee.email);
    const target = await owner.invitation.findFirstOrThrow({
      where: { organizationId: inviter.organizationId, email: invitee.email },
      select: { id: true },
    });

    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const revoking = blockerConnection.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT set_config('app.organization_id', ${inviter.organizationId}, true) AS scoped`;
        // Only `revokedAt` is written, so there is no `organizationId` in the
        // SET list and Postgres takes no foreign-key lock on the organisation
        // row — this blocker holds the INVITATION row and nothing else, which
        // is what lets the accept get past `lockOrganization` and reach its
        // conditional consume.
        const written = await tx.$executeRaw`
          UPDATE "Invitation" SET "revokedAt" = now() WHERE id = ${target.id}
        `;
        expect(written, 'The blocker revoked nothing; RLS refused the UPDATE.').toBe(1);
        await held;
      },
      { timeout: 120_000, maxWait: 30_000 },
    );

    let settled = false;
    const pending = request(server)
      .post(acceptPath)
      .set(csrf(invitee.actor))
      .send({ token })
      .then((answer) => {
        settled = true;
        return answer;
      });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    // It has read the invitation as live and is now waiting on the row lock the
    // revocation holds. If it had already answered, the consume was not
    // conditional on the row's committed state.
    expect(
      settled,
      'The accept answered while an uncommitted revocation held the invitation row, so its ' +
        'consume did not contend for that row — a `SELECT` then an `update` rather than a ' +
        'conditional `updateMany`.',
    ).toBe(false);

    release?.();
    await revoking;
    const response = await pending;

    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(codeOf(response.body)).toBe('TOKEN_INVALID');
    expect(
      await owner.membership.count({
        where: { organizationId: inviter.organizationId, userId: invitee.actor.userId },
      }),
    ).toBe(0);
    expect(
      await owner.auditEvent.count({
        where: { organizationId: inviter.organizationId, action: 'INVITATION_ACCEPTED' },
      }),
    ).toBe(0);
  }, 120_000);

  it('D9 — a Membership is not a bearer credential: suspending the organisation refuses the new member', async () => {
    // The second fact acceptance is issued against is the ORGANISATION'S STATE,
    // and no transaction can close that window: nothing in this API writes
    // `Organization.status`, so a suspension is an operator statement that can
    // land one microsecond after any re-read the handler could add. A re-read
    // would move the window, not close it.
    //
    // What makes that survivable is the structural difference from ruling 82's
    // `Session`. A session is a bearer credential carrying a captured privilege
    // for up to 30 days; a `Membership` is a row that is re-read on every
    // request — there is no permission cache (ruling 94) — so the organisation's
    // status is consulted afresh each time. Measured here rather than asserted.
    await clearRateLimits(harness.redis);
    const inviter = await acting('OWNER');
    const invitee = await acceptor();
    const token = await inviteAndCaptureToken(inviter.actor, inviter.organizationId, invitee.email);
    const accepted = await request(server)
      .post(acceptPath)
      .set(csrf(invitee.actor))
      .send({ token });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);

    // A FRESH session pointed at the organisation they have just joined, rather
    // than an `UPDATE` on the one they used to accept. `SessionService` caches
    // a resolved session in Redis keyed on the token hash, so rewriting the row
    // underneath a token that has already been resolved leaves the guard
    // reading `activeOrganizationId: null` from the cache — measured here as a
    // 404 before this was a new session. Minting a second one is also closer to
    // reality: `POST /auth/switch-org` rotates the token rather than mutating
    // the row.
    const inside = await sessionFor(invitee.actor.userId, inviter.organizationId);
    await clearRateLimits(harness.redis);
    const before = await request(server)
      .get(`/api/v1/organizations/${inviter.organizationId}`)
      .set('Cookie', inside.cookie);
    expect(before.status, JSON.stringify(before.body)).toBe(200);

    await owner.organization.update({
      where: { id: inviter.organizationId },
      data: { status: 'SUSPENDED' },
    });

    await clearRateLimits(harness.redis);
    const after = await request(server)
      .get(`/api/v1/organizations/${inviter.organizationId}`)
      .set('Cookie', inside.cookie);
    expect(after.status, JSON.stringify(after.body)).toBe(403);
    expect(codeOf(after.body)).toBe('ORGANIZATION_SUSPENDED');

    // The row is still there and still ACTIVE. That is the point: the
    // membership was not revoked, and it did not need to be.
    expect(
      await owner.membership.count({
        where: {
          organizationId: inviter.organizationId,
          userId: invitee.actor.userId,
          status: 'ACTIVE',
          deletedAt: null,
        },
      }),
    ).toBe(1);
  });

  it('D9 — RECORDS AN OPEN WINDOW: an invitation outlives its issuer’s authority', async () => {
    // **THIS TEST PINS A DEFECT, NOT A GUARANTEE.** It is written so the
    // behaviour cannot change silently while it is being decided, and it is
    // named so nobody reads it as approval.
    //
    // D5's no-minting check runs in `create` and nowhere else. An `OWNER` may
    // therefore issue an invitation offering `OWNER`, be removed from the
    // organisation, and have that invitation still mint an `OWNER` days later —
    // which is a re-escalation path for somebody who was removed precisely to
    // take that authority away, through an address they control.
    //
    // Ruling 122's remedy is on the OTHER side of this: the fact moves in
    // `MembershipService.remove` and `updateRole`, and that is where the
    // invitations the departing member issued and could no longer issue would
    // be revoked, in the same transaction as the demotion. That is a change to
    // Task 14's writes rather than to this handler, and it is handed up rather
    // than taken here. Re-running `assertActorMayGrant` at accept time instead
    // would refuse every invitation from a colleague who has since legitimately
    // left — a lock-out with no recovery path for the invitee.
    //
    // When it is closed, this test becomes the one that must be rewritten, and
    // the rewrite is the record that it was closed deliberately.
    await clearRateLimits(harness.redis);
    const home = await acting('OWNER');
    const second = await user();
    await membership({
      organizationId: home.organizationId,
      userId: second.id,
      role: 'OWNER',
    });
    const survivor = await sessionFor(second.id, home.organizationId);
    const invitee = await acceptor();

    // The departing owner issues an OWNER invitation while they still hold the
    // authority to do so.
    const token = await inviteAndCaptureToken(
      home.actor,
      home.organizationId,
      invitee.email,
      'OWNER',
    );

    // ...and is then removed by the other owner, through Task 14's endpoint.
    const inviterMembership = await owner.membership.findFirstOrThrow({
      where: { organizationId: home.organizationId, userId: home.actor.userId, deletedAt: null },
      select: { id: true },
    });
    await clearRateLimits(harness.redis);
    const removed = await request(server)
      .delete(`/api/v1/organizations/${home.organizationId}/members/${inviterMembership.id}`)
      .set(csrf(survivor));
    expect(removed.status, JSON.stringify(removed.body)).toBe(204);
    expect(
      await owner.membership.count({
        where: { organizationId: home.organizationId, userId: home.actor.userId, deletedAt: null },
      }),
    ).toBe(0);

    // MEASURED: the invitation is still live and still mints an OWNER.
    const accepted = await request(server)
      .post(acceptPath)
      .set(csrf(invitee.actor))
      .send({ token });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
    expect(membershipResponseSchema.parse(accepted.body).roleKey).toBe('OWNER');
  });
});
