import { describe, expect, it } from 'vitest';
import {
  acceptInvitationRequestSchema,
  createInvitationRequestSchema,
  invitationCollectionSchema,
  invitationResponseSchema,
  listInvitationsQuerySchema,
} from './invitations.js';
import { LIST_LIMIT_DEFAULT } from './pagination.js';

const INVITATION = {
  id: 'inv_01M0T74WZZFY9T2QS56RGF3GQ7',
  organizationId: 'org_01M0T74WZZFY9T2QS56RGF3GQ8',
  email: 'alice@example.com',
  roleKey: 'MEMBER',
  invitedByUserId: 'usr_01M0T74WZZFY9T2QS56RGF3GQ9',
  expiresAt: '2026-08-27T14:30:00Z',
  acceptedAt: null,
  revokedAt: null,
  createdAt: '2026-08-20T14:30:00Z',
};

describe('createInvitationRequestSchema', () => {
  it('normalises the invited address through the shared email schema', () => {
    // The invitation is bound to the address, and acceptance compares it to
    // the signed-in user's. Two different casings of one address would make
    // that comparison fail for the person actually invited.
    const parsed = createInvitationRequestSchema.parse({
      email: '  Alice@Example.COM ',
      roleKey: 'MEMBER',
    });
    expect(parsed.email).toBe('alice@example.com');
  });

  it('takes the role from the system role vocabulary', () => {
    expect(
      createInvitationRequestSchema.safeParse({ email: 'a@example.com', roleKey: 'SUPERUSER' })
        .success,
    ).toBe(false);
  });

  it('rejects an unknown field', () => {
    const result = createInvitationRequestSchema.safeParse({
      email: 'a@example.com',
      roleKey: 'MEMBER',
      expiresAt: '2030-01-01T00:00:00Z',
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.code).toBe('unrecognized_keys');
  });

  it('will not let a client choose the expiry', () => {
    // The 7-day TTL is the server's, from authentication.md §6. A caller who
    // could set it could mint a permanent invitation.
    expect(
      createInvitationRequestSchema.safeParse({
        email: 'a@example.com',
        roleKey: 'MEMBER',
        expiresAt: '2099-01-01T00:00:00Z',
      }).success,
    ).toBe(false);
  });
});

describe('acceptInvitationRequestSchema', () => {
  it('takes an opaque token and nothing else', () => {
    expect(acceptInvitationRequestSchema.parse({ token: 'abc' })).toEqual({ token: 'abc' });
    expect(
      acceptInvitationRequestSchema.safeParse({ token: 'abc', email: 'a@example.com' }).success,
    ).toBe(false);
  });

  it('rejects an empty token', () => {
    expect(acceptInvitationRequestSchema.safeParse({ token: '' }).success).toBe(false);
  });
});

describe('invitationResponseSchema', () => {
  it('accepts a pending invitation', () => {
    expect(invitationResponseSchema.parse(INVITATION).acceptedAt).toBeNull();
  });

  it('never carries the token', () => {
    // Only a hash is stored, and the raw token goes to the invited address
    // once. A list endpoint that echoed it would hand every member of the
    // organisation a working invitation for somebody else's address.
    const parsed = invitationResponseSchema.parse({ ...INVITATION, token: 'raw-secret' });
    expect(Object.keys(parsed)).not.toContain('token');
    expect(JSON.stringify(parsed)).not.toContain('raw-secret');
  });

  it('requires acceptedAt and revokedAt to be present, even when null', () => {
    const { acceptedAt, ...withoutAccepted } = INVITATION;
    expect(acceptedAt).toBeNull();
    expect(invitationResponseSchema.safeParse(withoutAccepted).success).toBe(false);
  });

  it('requires ISO 8601 timestamps with an offset', () => {
    expect(invitationResponseSchema.safeParse({ ...INVITATION, expiresAt: 'soon' }).success).toBe(
      false,
    );
  });
});

describe('listInvitationsQuerySchema', () => {
  it('is bounded — there is no unbounded invitation list', () => {
    expect(listInvitationsQuerySchema.parse({}).limit).toBe(LIST_LIMIT_DEFAULT);
  });
});

describe('invitationCollectionSchema', () => {
  it('wraps invitations in the collection envelope', () => {
    expect(
      invitationCollectionSchema.parse({
        data: [INVITATION],
        pagination: { nextCursor: null, hasMore: false },
      }).data,
    ).toHaveLength(1);
  });
});
