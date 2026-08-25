import { describe, expect, it } from 'vitest';
import {
  createOrganizationRequestSchema,
  listOrganizationsQuerySchema,
  ORGANIZATION_STATUSES,
  organizationCollectionSchema,
  organizationResponseSchema,
  organizationSlugSchema,
  updateOrganizationRequestSchema,
} from './organizations.js';
import { LIST_LIMIT_DEFAULT } from './pagination.js';

const ORG = {
  id: 'org_01M0T74WZZFY9T2QS56RGF3GQ7',
  slug: 'acme-security',
  name: 'Acme Security',
  status: 'ACTIVE',
  createdAt: '2026-08-20T14:30:00Z',
  updatedAt: '2026-08-20T14:30:00Z',
};

describe('organizationSlugSchema', () => {
  it('normalises to lower case and trims', () => {
    expect(organizationSlugSchema.parse('  Acme-Security  ')).toBe('acme-security');
  });

  it('accepts lowercase kebab-case only', () => {
    expect(organizationSlugSchema.safeParse('acme').success).toBe(true);
    expect(organizationSlugSchema.safeParse('acme-security-2').success).toBe(true);
    expect(organizationSlugSchema.safeParse('acme_security').success).toBe(false);
    expect(organizationSlugSchema.safeParse('-acme').success).toBe(false);
    expect(organizationSlugSchema.safeParse('acme--security').success).toBe(false);
    expect(organizationSlugSchema.safeParse('acme security').success).toBe(false);
  });

  it('is bounded at both ends', () => {
    expect(organizationSlugSchema.safeParse('ab').success).toBe(false);
    expect(organizationSlugSchema.safeParse('a'.repeat(64)).success).toBe(false);
  });
});

describe('createOrganizationRequestSchema', () => {
  it('accepts a name and a slug', () => {
    expect(createOrganizationRequestSchema.parse({ name: 'Acme', slug: 'acme' })).toEqual({
      name: 'Acme',
      slug: 'acme',
    });
  });

  it('rejects an unknown field', () => {
    const result = createOrganizationRequestSchema.safeParse({
      name: 'Acme',
      slug: 'acme',
      status: 'ACTIVE',
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.code).toBe('unrecognized_keys');
  });

  it('will not let a client set the status at creation', () => {
    // Status is a server-owned lifecycle field. A client that could post
    // `status: 'ACTIVE'` today would post `status: 'SUSPENDED'` tomorrow.
    expect(createOrganizationRequestSchema.safeParse({ ...ORG }).success).toBe(false);
  });
});

describe('updateOrganizationRequestSchema', () => {
  it('accepts a name change', () => {
    expect(updateOrganizationRequestSchema.parse({ name: 'Acme Ltd' })).toEqual({
      name: 'Acme Ltd',
    });
  });

  it('rejects an empty patch', () => {
    expect(updateOrganizationRequestSchema.safeParse({}).success).toBe(false);
  });

  it('rejects an unknown field', () => {
    expect(updateOrganizationRequestSchema.safeParse({ nmae: 'typo' }).success).toBe(false);
  });
});

describe('organizationResponseSchema', () => {
  it('accepts a complete organisation', () => {
    expect(organizationResponseSchema.parse(ORG).slug).toBe('acme-security');
  });

  it('pins the status list and rejects a value outside it (see enum-parity.spec.ts for the schema cross-check)', () => {
    expect([...ORGANIZATION_STATUSES]).toEqual(['ACTIVE', 'SUSPENDED', 'TERMINATED']);
    expect(organizationResponseSchema.safeParse({ ...ORG, status: 'DELETED' }).success).toBe(false);
  });

  it('requires timestamps to be UTC ISO 8601 strings', () => {
    // conventions.md §3. A `Date` serialises differently in every runtime and
    // a bare local time is ambiguous by an hour twice a year.
    expect(organizationResponseSchema.safeParse({ ...ORG, createdAt: new Date() }).success).toBe(
      false,
    );
    expect(
      organizationResponseSchema.safeParse({ ...ORG, createdAt: '2026-08-20T14:30:00' }).success,
    ).toBe(false);
    // "always UTC" — an explicit non-UTC offset is refused too. See
    // timestamps.spec.ts for the full behaviour of the shared schema.
    expect(
      organizationResponseSchema.safeParse({ ...ORG, createdAt: '2026-08-20T14:30:00+01:00' })
        .success,
    ).toBe(false);
  });
});

describe('listOrganizationsQuerySchema', () => {
  it('is bounded — there is no unbounded organisation list', () => {
    expect(listOrganizationsQuerySchema.parse({}).limit).toBe(LIST_LIMIT_DEFAULT);
  });
});

describe('organizationCollectionSchema', () => {
  it('wraps organisations in the collection envelope', () => {
    const parsed = organizationCollectionSchema.parse({
      data: [ORG],
      pagination: { nextCursor: null, hasMore: false, limit: 50 },
    });
    expect(parsed.data).toHaveLength(1);
  });
});
