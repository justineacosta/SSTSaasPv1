import { describe, expect, it } from 'vitest';
import { SYSTEM_ROLES } from './permissions.js';
import {
  listMembershipsQuerySchema,
  MEMBERSHIP_STATUSES,
  membershipCollectionSchema,
  membershipResponseSchema,
  roleCollectionSchema,
  roleResponseSchema,
  systemRoleSchema,
  updateMembershipRequestSchema,
} from './memberships.js';
import { LIST_LIMIT_DEFAULT } from './pagination.js';

const MEMBERSHIP = {
  id: 'mbr_01M0T74WZZFY9T2QS56RGF3GQ7',
  organizationId: 'org_01M0T74WZZFY9T2QS56RGF3GQ8',
  user: {
    id: 'usr_01M0T74WZZFY9T2QS56RGF3GQ9',
    email: 'alice@example.com',
    name: 'Alice',
  },
  roleKey: 'SECURITY_LEAD',
  status: 'ACTIVE',
  createdAt: '2026-08-20T14:30:00Z',
  updatedAt: '2026-08-20T14:30:00Z',
};

describe('systemRoleSchema', () => {
  it('is derived from SYSTEM_ROLES rather than re-declaring the list', () => {
    // A second copy of the role list is a second thing to forget when a role
    // is added. permissions.ts is the one place roles are named.
    expect(systemRoleSchema.options).toEqual([...SYSTEM_ROLES]);
  });

  it('rejects a role that is not a system role', () => {
    expect(systemRoleSchema.safeParse('SUPERUSER').success).toBe(false);
  });
});

describe('updateMembershipRequestSchema', () => {
  it('accepts a role change', () => {
    expect(updateMembershipRequestSchema.parse({ roleKey: 'ADMIN' })).toEqual({ roleKey: 'ADMIN' });
  });

  it('rejects an unknown field', () => {
    const result = updateMembershipRequestSchema.safeParse({ roleKey: 'ADMIN', status: 'REMOVED' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.code).toBe('unrecognized_keys');
  });

  it('will not let a client set the status directly', () => {
    // A Membership write must set `status` and `deletedAt` together — the
    // database CHECK constraint makes REMOVED and soft-deleted one fact. A
    // client-settable status would let a caller ask for half of it.
    expect(updateMembershipRequestSchema.safeParse({ status: 'REMOVED' }).success).toBe(false);
  });
});

describe('membershipResponseSchema', () => {
  it('accepts a complete membership', () => {
    expect(membershipResponseSchema.parse(MEMBERSHIP).user.email).toBe('alice@example.com');
  });

  it('matches the Prisma MembershipStatus enum exactly', () => {
    expect([...MEMBERSHIP_STATUSES]).toEqual(['ACTIVE', 'INVITED', 'REMOVED']);
    expect(membershipResponseSchema.safeParse({ ...MEMBERSHIP, status: 'PENDING' }).success).toBe(
      false,
    );
  });

  it('allows a null user name, which the schema permits', () => {
    const parsed = membershipResponseSchema.parse({
      ...MEMBERSHIP,
      user: { ...MEMBERSHIP.user, name: null },
    });
    expect(parsed.user.name).toBeNull();
  });

  it('requires ISO 8601 timestamps with an offset', () => {
    expect(
      membershipResponseSchema.safeParse({ ...MEMBERSHIP, createdAt: 'yesterday' }).success,
    ).toBe(false);
  });
});

describe('listMembershipsQuerySchema', () => {
  it('is bounded — there is no unbounded member list', () => {
    expect(listMembershipsQuerySchema.parse({}).limit).toBe(LIST_LIMIT_DEFAULT);
  });
});

describe('roleResponseSchema', () => {
  it('addresses a role by its key, not by a row ID', () => {
    const role = {
      key: 'AUDITOR',
      name: 'Auditor',
      description: 'Proves testing happened.',
      permissions: ['audit.read'],
      isSystem: true,
    };
    expect(roleResponseSchema.parse(role).key).toBe('AUDITOR');
  });

  it('rejects a permission outside the permission vocabulary', () => {
    expect(
      roleResponseSchema.safeParse({
        key: 'VIEWER',
        name: 'Viewer',
        description: 'Reads.',
        permissions: ['finding.obliterate'],
        isSystem: true,
      }).success,
    ).toBe(false);
  });
});

describe('the collection envelopes', () => {
  it('wrap memberships and roles', () => {
    expect(
      membershipCollectionSchema.parse({
        data: [MEMBERSHIP],
        pagination: { nextCursor: null, hasMore: false },
      }).data,
    ).toHaveLength(1);

    expect(
      roleCollectionSchema.parse({
        data: [],
        pagination: { nextCursor: null, hasMore: false },
      }).data,
    ).toHaveLength(0);
  });
});
