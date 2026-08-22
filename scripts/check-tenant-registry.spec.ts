import { describe, expect, it } from 'vitest';
import {
  findMultiplyAccountedModels,
  findStaleRegistryEntries,
  findUnaccountedModels,
  findUnexplainedGlobalEntries,
  findUnknownRegistryEntries,
  findUnregisteredTenantModels,
  findUnsafeCascades,
  type ModelInfo,
  type Registries,
} from './check-tenant-registry.js';

const membership: ModelInfo = { name: 'Membership', fields: ['id', 'organizationId', 'userId'] };
const asset: ModelInfo = { name: 'Asset', fields: ['id', 'organizationId', 'name'] };
const user: ModelInfo = { name: 'User', fields: ['id', 'email'] };

describe('findUnregisteredTenantModels', () => {
  it('returns nothing when every organizationId model is registered', () => {
    expect(findUnregisteredTenantModels([membership], ['Membership'])).toEqual([]);
  });

  it('reports a model carrying organizationId that is not registered', () => {
    expect(findUnregisteredTenantModels([membership, asset], ['Membership'])).toEqual(['Asset']);
  });

  it('ignores global models', () => {
    expect(findUnregisteredTenantModels([user], [])).toEqual([]);
  });

  it('reports every offender, not just the first', () => {
    const another: ModelInfo = { name: 'Finding', fields: ['id', 'organizationId'] };
    expect(findUnregisteredTenantModels([asset, another], [])).toEqual(['Asset', 'Finding']);
  });
});

describe('findStaleRegistryEntries', () => {
  it('reports a registered model that no longer carries organizationId', () => {
    expect(
      findStaleRegistryEntries([{ name: 'Membership', fields: ['id'] }], ['Membership']),
    ).toEqual(['Membership']);
  });

  it('reports a registered model that no longer exists at all', () => {
    expect(findStaleRegistryEntries([], ['Membership'])).toEqual(['Membership']);
  });

  it('returns nothing when the registry is accurate', () => {
    expect(findStaleRegistryEntries([membership], ['Membership'])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Step 2c — every model accounted for by exactly one of the three registries.
//
// A check keyed on the `organizationId` column can never flag `Organization`,
// the model that leaked hardest, because the tenant root does not carry the
// column it is the root of. Accounting closes that: a model that is in none of
// the three registries has been thought about by nobody.
// ---------------------------------------------------------------------------

const organization: ModelInfo = { name: 'Organization', fields: ['id', 'slug'] };

const registries: Registries = {
  tenantOwned: ['Membership'],
  tenantRoot: 'Organization',
  deliberatelyGlobal: ['User'],
};

describe('findUnaccountedModels', () => {
  it('returns nothing when every model is in exactly one registry', () => {
    expect(findUnaccountedModels([membership, organization, user], registries)).toEqual([]);
  });

  it('reports a model that is in none of the three registries', () => {
    expect(findUnaccountedModels([membership, organization, user, asset], registries)).toEqual([
      'Asset',
    ]);
  });

  it('reports the tenant root when it is not named as the tenant root', () => {
    // The case a column-keyed check structurally cannot see: `Organization`
    // carries no `organizationId`, so `findUnregisteredTenantModels` is blind
    // to it. Accounting is the only rule that catches it.
    expect(
      findUnaccountedModels([organization], {
        tenantOwned: [],
        tenantRoot: 'SomethingElse',
        deliberatelyGlobal: [],
      }),
    ).toEqual(['Organization']);
  });
});

describe('findMultiplyAccountedModels', () => {
  it('returns nothing when the registries do not overlap', () => {
    expect(findMultiplyAccountedModels([membership, organization, user], registries)).toEqual([]);
  });

  it('reports a model claimed by both tenant-owned and deliberately-global', () => {
    expect(
      findMultiplyAccountedModels([membership], {
        tenantOwned: ['Membership'],
        tenantRoot: 'Organization',
        deliberatelyGlobal: ['Membership'],
      }),
    ).toEqual(['Membership']);
  });

  it('reports the tenant root also listed as deliberately global', () => {
    expect(
      findMultiplyAccountedModels([organization], {
        tenantOwned: [],
        tenantRoot: 'Organization',
        deliberatelyGlobal: ['Organization'],
      }),
    ).toEqual(['Organization']);
  });
});

describe('findUnknownRegistryEntries', () => {
  it('returns nothing when every registered name is a real model', () => {
    expect(findUnknownRegistryEntries([membership, organization, user], registries)).toEqual([]);
  });

  it('reports a deliberately-global entry naming a model that does not exist', () => {
    expect(
      findUnknownRegistryEntries([membership, organization], {
        tenantOwned: ['Membership'],
        tenantRoot: 'Organization',
        deliberatelyGlobal: ['Ghost'],
      }),
    ).toEqual(['Ghost']);
  });

  it('reports a tenant root naming a model that does not exist', () => {
    expect(
      findUnknownRegistryEntries([membership], {
        tenantOwned: ['Membership'],
        tenantRoot: 'Nowhere',
        deliberatelyGlobal: [],
      }),
    ).toEqual(['Nowhere']);
  });
});

describe('findUnexplainedGlobalEntries', () => {
  it('returns nothing when every global entry carries a reason', () => {
    expect(findUnexplainedGlobalEntries({ User: 'One human, many organisations.' })).toEqual([]);
  });

  it('reports an entry whose reason is empty', () => {
    // An unexplained entry on that list is how a tenant-owned table gets
    // parked there to make the build go green.
    expect(findUnexplainedGlobalEntries({ User: '   ' })).toEqual(['User']);
  });
});

// ---------------------------------------------------------------------------
// Step 2b — the FK-cascade structural rule.
//
// The qualifier is the whole rule. "Every FK into a tenant-owned table is
// RESTRICT" is FALSE: Membership.organizationId and Invitation.organizationId
// are Cascade and correct, because the parent there is the tenant root
// deleting its own rows. security/tenant-isolation.md §2 (Layer 2) was
// corrected once already for stating it without the qualifier.
// ---------------------------------------------------------------------------

const cascadeRegistries: Registries = {
  tenantOwned: ['Membership'],
  tenantRoot: 'Organization',
  deliberatelyGlobal: ['User', 'Role'],
};

describe('findUnsafeCascades', () => {
  it('accepts a cascade from the tenant root into a tenant-owned table', () => {
    const model: ModelInfo = {
      name: 'Membership',
      fields: ['id', 'organizationId'],
      relations: [{ field: 'organization', parentModel: 'Organization', onDelete: 'Cascade' }],
    };
    expect(findUnsafeCascades([model], cascadeRegistries)).toEqual([]);
  });

  it('rejects a cascade from a non-tenant-scoped parent into a tenant-owned table', () => {
    // The exact live defect Task 6 found and fixed: deleting a User destroyed
    // every other tenant's Membership row for them, below both RLS and the
    // tenant-scoped client.
    const model: ModelInfo = {
      name: 'Membership',
      fields: ['id', 'organizationId', 'userId'],
      relations: [{ field: 'user', parentModel: 'User', onDelete: 'Cascade' }],
    };
    expect(findUnsafeCascades([model], cascadeRegistries)).toEqual([
      { model: 'Membership', field: 'user', parentModel: 'User', kind: 'cascade' },
    ]);
  });

  it('accepts Restrict from a non-tenant-scoped parent', () => {
    const model: ModelInfo = {
      name: 'Membership',
      fields: ['id', 'organizationId', 'userId'],
      relations: [{ field: 'user', parentModel: 'User', onDelete: 'Restrict' }],
    };
    expect(findUnsafeCascades([model], cascadeRegistries)).toEqual([]);
  });

  it('rejects an omitted onDelete rather than assuming Prisma’s default', () => {
    // Measured against Prisma 6.19.3: when the schema omits `onDelete`, the
    // DMMF relation field has NO `relationOnDelete` key at all. The check
    // refuses to guess, because the guess would have to be right about field
    // optionality (Restrict for required, SetNull for optional) forever.
    const model: ModelInfo = {
      name: 'Membership',
      fields: ['id', 'organizationId', 'roleId'],
      relations: [{ field: 'role', parentModel: 'Role', onDelete: undefined }],
    };
    expect(findUnsafeCascades([model], cascadeRegistries)).toEqual([
      { model: 'Membership', field: 'role', parentModel: 'Role', kind: 'undeclared' },
    ]);
  });

  it('ignores relations on models that are not tenant-owned', () => {
    // Session.userId is Cascade and that is fine: a Session belongs to one
    // user, not to a tenant, so deleting the user cannot cross a boundary.
    const session: ModelInfo = {
      name: 'Session',
      fields: ['id', 'userId'],
      relations: [{ field: 'user', parentModel: 'User', onDelete: 'Cascade' }],
    };
    expect(findUnsafeCascades([session], cascadeRegistries)).toEqual([]);
  });

  it('reports every offending relation, not just the first', () => {
    const model: ModelInfo = {
      name: 'Membership',
      fields: ['id', 'organizationId', 'userId', 'roleId'],
      relations: [
        { field: 'organization', parentModel: 'Organization', onDelete: 'Cascade' },
        { field: 'user', parentModel: 'User', onDelete: 'Cascade' },
        { field: 'role', parentModel: 'Role', onDelete: 'Cascade' },
      ],
    };
    expect(findUnsafeCascades([model], cascadeRegistries)).toEqual([
      { model: 'Membership', field: 'user', parentModel: 'User', kind: 'cascade' },
      { model: 'Membership', field: 'role', parentModel: 'Role', kind: 'cascade' },
    ]);
  });
});
