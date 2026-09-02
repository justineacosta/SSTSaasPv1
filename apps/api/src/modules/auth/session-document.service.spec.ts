import { describe, expect, it } from 'vitest';
import { sessionResponseSchema, type Permission } from '@sentinel/contracts';
import type { ActiveOrganizationLookup } from './active-organization.store.js';
import {
  type ActiveOrganizationSource,
  SessionDocumentService,
} from './session-document.service.js';

/**
 * THE SESSION DOCUMENT, AND THE TWO FIELDS THAT TELL THE TRUTH ABOUT NOT
 * EXISTING YET.
 *
 * `permissions: []` and `entitlements: {}` are not placeholders to be quietly
 * filled in later — they are the honest values, and the assertions below are
 * what stop a future edit substituting a guess. The non-null
 * `activeOrganization` arm is proved here against a fake and again in the
 * integration lane against a real `Organization` row read over the
 * least-privileged database role, which is the half that can actually fail.
 */

const PRINCIPAL = {
  userId: 'usr_01M0T74WZZFY9T2QS56RGF3GQ7',
  sessionId: 'ses_01M0T74WZZFY9T2QS56RGF3GQ7',
};

const ORGANIZATION = {
  id: 'org_01M0T74WZZFY9T2QS56RGF3GQ7',
  slug: 'acme-security',
  name: 'Acme Security',
};

function harness(options: { activeOrganizationId?: string | null; sessionMissing?: boolean } = {}) {
  const asked: string[] = [];
  const sessions: ActiveOrganizationSource = {
    findById: (sessionId) => {
      asked.push(`session:${sessionId}`);
      if (options.sessionMissing === true) return Promise.resolve(null);
      return Promise.resolve({ activeOrganizationId: options.activeOrganizationId ?? null });
    },
  };
  const organizations: ActiveOrganizationLookup = {
    find: (organizationId) => {
      asked.push(`organization:${organizationId}`);
      return Promise.resolve(organizationId === ORGANIZATION.id ? ORGANIZATION : null);
    },
  };
  return { service: new SessionDocumentService(sessions, organizations), asked };
}

describe('SessionDocumentService.forPrincipal', () => {
  it('returns a document the published contract accepts', async () => {
    // `sessionResponseSchema` is the wire contract and `check:openapi` pins it.
    // Parsing the real output through it here means a field this service adds
    // by hand cannot reach a client without the schema learning about it first.
    const { service } = harness();
    const document = await service.forPrincipal(PRINCIPAL, undefined);
    expect(sessionResponseSchema.parse(document)).toEqual(document);
  });

  it('names the principal and nothing else about the session', async () => {
    // No `sessionId`. `sessionResponseSchema` omits it deliberately: a session
    // identifier has no business being readable by a script running in the
    // page, and a client that has one will eventually put it in a URL.
    const { service } = harness();
    const document = await service.forPrincipal(PRINCIPAL, undefined);
    expect(document.userId).toBe(PRINCIPAL.userId);
    expect(Object.keys(document).sort()).toEqual([
      'activeOrganization',
      'entitlements',
      'permissions',
      'userId',
    ]);
  });

  it('reports an EMPTY permission set when no tenant resolved', async () => {
    // Which is every session Phase 2 can create: nothing writes
    // `Session.activeOrganizationId` until Task 13, so `TenantContextGuard`
    // resolves nothing and passes `undefined`. Empty is the accurate report and
    // the fail-closed direction, not a placeholder.
    const { service } = harness();
    expect((await service.forPrincipal(PRINCIPAL, undefined)).permissions).toEqual([]);
  });

  it('reports the resolved permission set when a tenant DID resolve', async () => {
    // The other half, and the one that makes the assertion above non-vacuous.
    // Before Task 12 this service returned `[]` unconditionally, so a test of
    // the empty case alone could not tell a real computation from a constant.
    const { service } = harness();
    const document = await service.forPrincipal(PRINCIPAL, {
      organizationId: ORGANIZATION.id,
      membershipId: 'mbr_01J000000000000000000001',
      roleKey: 'AUDITOR',
      permissions: new Set<Permission>(['audit.read', 'organization.read']),
    });
    expect(document.permissions).toEqual(['audit.read', 'organization.read']);
  });

  it('sorts the permission set, because a response is a sequence and a Set is not', async () => {
    // An unstable order makes two identical documents differ, which breaks byte
    // comparison in tests and cache validation in clients.
    const { service } = harness();
    const document = await service.forPrincipal(PRINCIPAL, {
      organizationId: ORGANIZATION.id,
      membershipId: 'mbr_01J000000000000000000001',
      roleKey: 'AUDITOR',
      permissions: new Set<Permission>(['organization.read', 'audit.read']),
    });
    expect(document.permissions).toEqual(['audit.read', 'organization.read']);
  });

  it('reports empty entitlements, because billing is Phase 5', async () => {
    const { service } = harness();
    expect((await service.forPrincipal(PRINCIPAL, undefined)).entitlements).toEqual({});
  });

  it('reports a null organisation and does NOT ask, when the session names none', async () => {
    // Every session Phase 2 can create is in this state: nothing writes
    // `Session.activeOrganizationId` until Task 13. Not asking is the point —
    // the lookup opens a transaction, and opening one to look up `null` would
    // put a database round trip on every `GET /auth/session` in the product.
    const { service, asked } = harness({ activeOrganizationId: null });
    const document = await service.forPrincipal(PRINCIPAL, undefined);

    expect(document.activeOrganization).toBeNull();
    expect(asked).toEqual([`session:${PRINCIPAL.sessionId}`]);
  });

  it('resolves the organisation for real when the session names one', async () => {
    const { service, asked } = harness({ activeOrganizationId: ORGANIZATION.id });
    const document = await service.forPrincipal(PRINCIPAL, undefined);

    expect(document.activeOrganization).toEqual(ORGANIZATION);
    expect(asked).toEqual([`session:${PRINCIPAL.sessionId}`, `organization:${ORGANIZATION.id}`]);
  });

  it('reports null when the named organisation cannot be read', async () => {
    // Deleted, or invisible to the row-level security policy. `null` rather
    // than a throw: the caller is signed in and the session document is how the
    // frontend learns anything at all, so failing the whole request over an
    // organisation that has gone would sign them out of a product they are
    // still entitled to use. Task 13 owns clearing the stale column.
    const { service } = harness({ activeOrganizationId: 'org_01M0T74WZZFY9T2QS56RGF3GQ8' });
    expect((await service.forPrincipal(PRINCIPAL, undefined)).activeOrganization).toBeNull();
  });

  it('reports null when the session row itself has vanished', async () => {
    // Unreachable through the guard, which resolved this session moments ago.
    // Handled rather than left to throw on a property of `null`, because the
    // failure would be a 500 on a request that is otherwise fine.
    const { service } = harness({ sessionMissing: true });
    expect((await service.forPrincipal(PRINCIPAL, undefined)).activeOrganization).toBeNull();
  });
});
