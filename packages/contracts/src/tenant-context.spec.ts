import { describe, expect, it } from 'vitest';
import type { Permission } from './permissions.js';
import type { TenantContext } from './tenant-context.js';

const context: TenantContext = {
  organizationId: 'org_01M0T74WZZFY9T2QS56RGF3GQ7',
  membershipId: 'mbr_01M0T74WZZFY9T2QS56RGF3GQ8',
  roleKey: 'SECURITY_LEAD',
  permissions: new Set<Permission>(['finding.read', 'finding.triage']),
};

describe('TenantContext', () => {
  it('carries the four facts a handler needs to authorise a request', () => {
    expect(context.organizationId).toMatch(/^org_/);
    expect(context.membershipId).toMatch(/^mbr_/);
    expect(context.roleKey).toBe('SECURITY_LEAD');
    expect(context.permissions.has('finding.triage')).toBe(true);
  });

  it('exposes permissions as a genuinely read-only set', () => {
    // The cheapest possible proof, and the one that matters: a handler must
    // not be able to widen its own permission set mid-request. `ReadonlySet`
    // has no `add`, so the call below is a compile error — and
    // `@ts-expect-error` turns "compile error" into a test that fails loudly if
    // the type is ever relaxed to `Set<Permission>`.
    //
    // The eslint block-disable is unavoidable rather than lazy: suppressing a
    // type error leaves the expression typed as `error`, which the type-aware
    // `no-unsafe-call` and `no-unsafe-return` rules then report, and a
    // `// eslint-disable-next-line` cannot be stacked above a
    // `@ts-expect-error` — TypeScript applies the latter to the very next line,
    // so any comment between them detaches it.
    /* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */
    // @ts-expect-error ReadonlySet has no `add`; widening a live permission set is the bug this prevents.
    const widen = () => context.permissions.add('organization.delete');
    /* eslint-enable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */
    expect(widen).toBeInstanceOf(Function);
  });

  it('types roleKey as a SystemRole, not a free string', () => {
    // @ts-expect-error 'SUPERUSER' is not a SystemRole; roles come from permissions.ts.
    const invalid: TenantContext['roleKey'] = 'SUPERUSER';
    expect(invalid).toBe('SUPERUSER');
  });

  it('types permissions by the Permission union, not by string', () => {
    // @ts-expect-error 'finding.obliterate' is not a Permission.
    const invalid: ReadonlySet<Permission> = new Set(['finding.obliterate']);
    expect(invalid.size).toBe(1);
  });
});
