import { describe, expect, it } from 'vitest';
import type { Permission, TenantContext } from '@sentinel/contracts';
import { DomainError } from '../../common/errors/domain-error.js';
import { assertPathIsActiveTenant } from './organization.service.js';

const ACTIVE = 'org_01M0T74WZZFY9T2QS56RGF3GQ7';
const OTHER = 'org_01M0T74WZZFY9T2QS56RGF3GQ8';

function context(organizationId: string): TenantContext {
  return {
    organizationId,
    membershipId: 'mbr_01M0T74WZZFY9T2QS56RGF3GQ7',
    roleKey: 'OWNER',
    permissions: new Set<Permission>(['organization.read']),
  };
}

/**
 * D4 AS A PURE FUNCTION, WHICH IS THE ONLY WAY TO TEST IT EXHAUSTIVELY.
 *
 * The rule is that `:id` is checked *against* the resolved tenant and never
 * used to select one. Proving that end-to-end needs a request per case and a
 * seeded organisation per case; proving it here needs neither, and the
 * integration suite then only has to show that the handler calls this rather
 * than re-deriving every branch over HTTP.
 */
describe('assertPathIsActiveTenant', () => {
  it('admits the path id that IS the resolved tenant', () => {
    expect(() => assertPathIsActiveTenant(context(ACTIVE), ACTIVE)).not.toThrow();
  });

  it('refuses another organisation with 404, not 403', () => {
    // `security/authorization.md` §6: a 403 confirms the resource exists. This
    // is the cross-tenant case and it must be indistinguishable from absence.
    let thrown: unknown;
    try {
      assertPathIsActiveTenant(context(ACTIVE), OTHER);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DomainError);
    const error = thrown as DomainError;
    expect(error.status).toBe(404);
    expect(error.code).toBe('RESOURCE_NOT_FOUND');
  });

  it('refuses an id that does not exist with the same error', () => {
    // The point is that this function cannot tell the difference, and neither
    // can the caller. It performs no lookup at all — an id that has never
    // existed and one belonging to somebody else take the same branch.
    const missing = 'org_00000000000000000000000000';
    let thrown: unknown;
    try {
      assertPathIsActiveTenant(context(ACTIVE), missing);
    } catch (error) {
      thrown = error;
    }
    const error = thrown as DomainError;
    expect(error.status).toBe(404);
    expect(error.message).toBe('Not found.');
  });

  it('refuses an organisation the caller IS a member of but is not acting in', () => {
    // The surprising case, and the deliberate one. The path does not select the
    // tenant; the session does. Answering anything but 404 here would mean the
    // path had selected it, which is the input-controlled tenant selection
    // `tenant-context.ts` exists to prevent — and it would route around the
    // organisation-status check, the MFA-enrolment gate and the permission
    // check, all of which key on the tenant the guard resolved.
    //
    // This function cannot see membership, which is exactly why it is safe:
    // there is no branch here that could be taught to make an exception.
    expect(() => assertPathIsActiveTenant(context(ACTIVE), OTHER)).toThrow(DomainError);
  });

  it('is case-sensitive and exact, with no normalisation', () => {
    // An id comparison that lower-cased, trimmed or prefix-matched would be a
    // comparison an attacker can aim. Crockford base32 ids are upper-case, so a
    // lower-cased variant is the obvious probe.
    expect(() => assertPathIsActiveTenant(context(ACTIVE), ACTIVE.toLowerCase())).toThrow(
      DomainError,
    );
    expect(() => assertPathIsActiveTenant(context(ACTIVE), ` ${ACTIVE}`)).toThrow(DomainError);
    expect(() => assertPathIsActiveTenant(context(ACTIVE), ACTIVE.slice(0, -1))).toThrow(
      DomainError,
    );
  });

  it('refuses the empty string', () => {
    // Not reachable through the router — `@Get(':id')` does not match an empty
    // segment — and asserted anyway, because "the check passed because both
    // sides were falsy" is the shape this family of bug takes.
    expect(() => assertPathIsActiveTenant(context(ACTIVE), '')).toThrow(DomainError);
  });
});
