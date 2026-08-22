import { describe, expect, it } from 'vitest';
import { decideScope, scopeUniqueWhere, withScopedData, withScopedWhere } from './tenant-scope.js';

describe('decideScope', () => {
  it('passes through models that are neither tenant-owned nor the tenant root', () => {
    expect(decideScope('User', 'findMany', {}, 'org_a')).toEqual({ kind: 'passthrough' });
  });

  it('refuses when there is no organisation in context — empty string', () => {
    expect(decideScope('Membership', 'findMany', {}, '')).toEqual({ kind: 'refuse' });
  });

  it('refuses when there is no organisation in context — undefined', () => {
    expect(decideScope('Membership', 'findMany', {}, undefined)).toEqual({ kind: 'refuse' });
  });

  it('refuses when there is no organisation in context — null', () => {
    // N1: the context guard previously checked only '' and undefined, missing
    // null. TenantContext's type forbids it, but nothing at runtime stops a
    // caller building one without going through the type checker.
    expect(decideScope('Membership', 'findMany', {}, null)).toEqual({ kind: 'refuse' });
  });

  it('refuses any operation not explicitly enumerated, rather than passing it through', () => {
    // This is the property M1 asked to be proven directly: every real Prisma
    // operation on a tenant-scoped model is now handled (see tenant-client.ts's
    // review report), so this exact branch is unreachable through the public
    // Prisma API. Only a unit test with a name Prisma will never actually send
    // can exercise it — which is exactly why it needs to be a unit test, not
    // an integration one: an integration suite can only prove what it happens
    // to call, and every real operation is already covered.
    const plan = decideScope('Membership', 'someOperationThatDoesNotExist', {}, 'org_a');
    expect(plan).toEqual({ kind: 'refuse' });
  });

  it('refuses create/createMany/createManyAndReturn/upsert on the tenant root', () => {
    for (const operation of ['create', 'createMany', 'createManyAndReturn', 'upsert']) {
      expect(decideScope('Organization', operation, {}, 'org_a')).toEqual({ kind: 'refuse' });
    }
  });

  it('rewrites findUnique to a run-and-check plan instead of a different operation', () => {
    const plan = decideScope('Membership', 'findUnique', { where: { id: 'mbr_x' } }, 'org_a');
    expect(plan).toEqual({
      kind: 'run-and-check',
      args: { where: { id: 'mbr_x' } },
      checkField: 'organizationId',
      expected: 'org_a',
      notFoundIsThrow: false,
      stripCheckField: false,
    });
  });

  it('marks findUniqueOrThrow so a scope mismatch throws instead of returning null', () => {
    const plan = decideScope(
      'Membership',
      'findUniqueOrThrow',
      { where: { id: 'mbr_x' } },
      'org_a',
    );
    expect(plan.kind).toBe('run-and-check');
    expect(plan.kind === 'run-and-check' && plan.notFoundIsThrow).toBe(true);
  });

  it('widens a select that omits the scope column, and flags it for stripping', () => {
    // Important (review round 3): reading the scope column off the result
    // only works if the query actually fetched it. A caller's own `select`
    // must not silently make an owned row look like it belongs to nobody.
    const plan = decideScope(
      'Membership',
      'findUnique',
      { where: { id: 'mbr_x' }, select: { id: true, status: true } },
      'org_a',
    );
    expect(plan).toEqual({
      kind: 'run-and-check',
      args: { where: { id: 'mbr_x' }, select: { id: true, status: true, organizationId: true } },
      checkField: 'organizationId',
      expected: 'org_a',
      notFoundIsThrow: false,
      stripCheckField: true,
    });
  });

  it('leaves a select that already asks for the scope column alone', () => {
    const plan = decideScope(
      'Membership',
      'findUnique',
      { where: { id: 'mbr_x' }, select: { id: true, organizationId: true } },
      'org_a',
    );
    expect(plan).toEqual({
      kind: 'run-and-check',
      args: { where: { id: 'mbr_x' }, select: { id: true, organizationId: true } },
      checkField: 'organizationId',
      expected: 'org_a',
      notFoundIsThrow: false,
      stripCheckField: false,
    });
  });

  it('drops the scope column from an omit that excludes it, and flags it for stripping', () => {
    const plan = decideScope(
      'Membership',
      'findUnique',
      { where: { id: 'mbr_x' }, omit: { organizationId: true, updatedAt: true } },
      'org_a',
    );
    expect(plan).toEqual({
      kind: 'run-and-check',
      args: { where: { id: 'mbr_x' }, omit: { updatedAt: true } },
      checkField: 'organizationId',
      expected: 'org_a',
      notFoundIsThrow: false,
      stripCheckField: true,
    });
  });

  it('leaves an omit that does not exclude the scope column alone', () => {
    const plan = decideScope(
      'Membership',
      'findUnique',
      { where: { id: 'mbr_x' }, omit: { updatedAt: true } },
      'org_a',
    );
    expect(plan).toEqual({
      kind: 'run-and-check',
      args: { where: { id: 'mbr_x' }, omit: { updatedAt: true } },
      checkField: 'organizationId',
      expected: 'org_a',
      notFoundIsThrow: false,
      stripCheckField: false,
    });
  });

  it('widens select by id for the tenant root too', () => {
    const plan = decideScope(
      'Organization',
      'findUnique',
      { where: { id: 'org_a' }, select: { name: true } },
      'org_a',
    );
    expect(plan).toEqual({
      kind: 'run-and-check',
      args: { where: { id: 'org_a' }, select: { name: true, id: true } },
      checkField: 'id',
      expected: 'org_a',
      notFoundIsThrow: false,
      stripCheckField: true,
    });
  });

  it('scopes the tenant root by id, not organizationId', () => {
    const plan = decideScope('Organization', 'findMany', { where: { status: 'ACTIVE' } }, 'org_a');
    expect(plan).toEqual({
      kind: 'run',
      args: { where: { status: 'ACTIVE', id: 'org_a' } },
    });
  });

  it('injects organizationId into data for create', () => {
    const plan = decideScope('Membership', 'create', { data: { userId: 'usr_x' } }, 'org_a');
    expect(plan).toEqual({
      kind: 'run',
      args: { data: { userId: 'usr_x', organizationId: 'org_a' } },
    });
  });

  it('forces both where and data for update, overriding a caller-supplied value', () => {
    const plan = decideScope(
      'Membership',
      'update',
      { where: { id: 'mbr_x' }, data: { organizationId: 'org_evil', status: 'REMOVED' } },
      'org_a',
    );
    expect(plan).toEqual({
      kind: 'run',
      args: {
        where: { id: 'mbr_x', organizationId: 'org_a' },
        data: { organizationId: 'org_a', status: 'REMOVED' },
      },
    });
  });

  it('refuses delete on the tenant root when the caller targets a different org by id', () => {
    // `delete`'s `where` is a WhereUniqueInput: it cannot be AND-combined the
    // way findMany/deleteMany's general WhereInput can (see withScopedWhere's
    // test below), so a collision on the scope field itself — `id`, for the
    // tenant root — must refuse outright rather than attempt an invalid shape
    // or silently redirect onto the caller's own org.
    const plan = decideScope('Organization', 'delete', { where: { id: 'org_b' } }, 'org_a');
    expect(plan).toEqual({ kind: 'refuse' });
  });

  it('allows delete on the tenant root when the caller targets their own org', () => {
    const plan = decideScope('Organization', 'delete', { where: { id: 'org_a' } }, 'org_a');
    expect(plan).toEqual({ kind: 'run', args: { where: { id: 'org_a' } } });
  });

  it('refuses update on the tenant root when the caller targets a different org by id', () => {
    const plan = decideScope(
      'Organization',
      'update',
      { where: { id: 'org_b' }, data: { name: 'Hijacked' } },
      'org_a',
    );
    expect(plan).toEqual({ kind: 'refuse' });
  });
});

describe('withScopedWhere', () => {
  it('adds the scope key when the caller has not already filtered on it', () => {
    expect(withScopedWhere({ id: 'x' }, 'organizationId', 'org_a')).toEqual({
      id: 'x',
      organizationId: 'org_a',
    });
  });

  it('AND-combines instead of overwriting when the caller already filters on the scope key', () => {
    // Valid here because the operations that use this helper (findMany,
    // deleteMany, updateMany, ...) accept a general WhereInput, which has no
    // "must be a flat unique field" constraint — unlike WhereUniqueInput,
    // see scopeUniqueWhere below.
    const result = withScopedWhere({ id: 'org_b' }, 'id', 'org_a');
    expect(result).toEqual({ AND: [{ id: 'org_b' }, { id: 'org_a' }] });
  });
});

describe('scopeUniqueWhere', () => {
  it('adds the scope key when the caller has not already filtered on it', () => {
    expect(scopeUniqueWhere({ id: 'x' }, 'organizationId', 'org_a')).toEqual({
      ok: true,
      where: { id: 'x', organizationId: 'org_a' },
    });
  });

  it('leaves the where clause as is when the caller already targets their own tenant', () => {
    expect(scopeUniqueWhere({ id: 'org_a' }, 'id', 'org_a')).toEqual({
      ok: true,
      where: { id: 'org_a' },
    });
  });

  it('refuses — does not AND-wrap — when the caller targets a different tenant on the scope field', () => {
    // This is the redirect problem this helper exists to prevent: `id` is
    // both the caller's own filter and the scope key for the tenant root, so
    // a plain override would silently retarget "delete org B" onto "delete
    // my own org" instead of failing to match the row actually requested.
    // AND-wrapping (as withScopedWhere does) is not a valid alternative here
    // — WhereUniqueInput requires a flat unique field — so the only safe
    // outcome is refusing the operation outright.
    expect(scopeUniqueWhere({ id: 'org_b' }, 'id', 'org_a')).toEqual({ ok: false });
  });
});

describe('withScopedData', () => {
  it('forces the scope key on a single object, overriding any caller value', () => {
    expect(withScopedData({ organizationId: 'org_evil', a: 1 }, 'organizationId', 'org_a')).toEqual(
      {
        organizationId: 'org_a',
        a: 1,
      },
    );
  });

  it('forces the scope key on every element of an array payload', () => {
    expect(
      withScopedData([{ a: 1 }, { a: 2, organizationId: 'org_evil' }], 'organizationId', 'org_a'),
    ).toEqual([
      { a: 1, organizationId: 'org_a' },
      { a: 2, organizationId: 'org_a' },
    ]);
  });
});
