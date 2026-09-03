import { describe, expect, it } from 'vitest';
import { ROLE_PERMISSIONS, type Permission, type TenantContext } from '@sentinel/contracts';
import { DomainError } from '../../common/errors/domain-error.js';
import { assertActorMayGrant } from './membership.service.js';

const ORGANIZATION = 'org_01M0T74WZZFY9T2QS56RGF3GQ7';

/**
 * A context holding exactly the permissions a system role holds, built from
 * `ROLE_PERMISSIONS` rather than from a hand-written list.
 *
 * The hand-written list is what a test like this is normally wrong about: a
 * permission added to `ADMIN` next year would leave a literal here asserting
 * yesterday's answer, and the test would still be green.
 */
function actor(roleKey: keyof typeof ROLE_PERMISSIONS): TenantContext {
  return {
    organizationId: ORGANIZATION,
    membershipId: 'mbr_01M0T74WZZFY9T2QS56RGF3GQ7',
    roleKey,
    permissions: new Set<Permission>(ROLE_PERMISSIONS[roleKey]),
  };
}

const caught = (fn: () => void): DomainError | undefined => {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error as DomainError;
  }
};

/**
 * D5 AS A PURE FUNCTION — `security/authorization.md` §4's no-minting rule.
 *
 * "A custom role may hold any subset of permissions the creator themselves
 * holds — you cannot mint authority you do not possess." The document writes it
 * for custom roles; it binds a role change for the same reason, and the
 * concrete case is not hypothetical: an `ADMIN` holds
 * `organization.manage_roles` and would otherwise be able to promote a
 * colleague — or a second account of their own — to `OWNER`, and have them
 * delete the organisation.
 *
 * Tested here rather than only over HTTP because the rule is a comparison of
 * sets, and there are 7 x 7 pairs of system roles. Proving it end-to-end would
 * need 49 seeded organisations; proving it here needs none, and the integration
 * suite then only has to show that the handler calls this.
 */
describe('assertActorMayGrant', () => {
  it('admits a role whose permissions the actor holds exactly', () => {
    expect(() => assertActorMayGrant(actor('ADMIN'), ROLE_PERMISSIONS.ADMIN)).not.toThrow();
  });

  it('admits a strictly weaker role', () => {
    expect(() => assertActorMayGrant(actor('ADMIN'), ROLE_PERMISSIONS.VIEWER)).not.toThrow();
  });

  it('refuses an ADMIN granting OWNER, naming the permission ADMIN lacks', () => {
    const error = caught(() => {
      assertActorMayGrant(actor('ADMIN'), ROLE_PERMISSIONS.OWNER);
    });
    expect(error).toBeInstanceOf(DomainError);
    expect(error?.status).toBe(403);
    expect(error?.code).toBe('PERMISSION_DENIED');
    // Deterministic: the first missing permission in `PERMISSIONS` order, not
    // whatever order the seeded grant rows came back in.
    expect(error?.details).toMatchObject({ required: 'organization.delete', yourRole: 'ADMIN' });
  });

  it('admits an OWNER granting anything, because OWNER holds every permission', () => {
    const owner = actor('OWNER');
    for (const roleKey of Object.keys(ROLE_PERMISSIONS) as (keyof typeof ROLE_PERMISSIONS)[]) {
      expect(() => {
        assertActorMayGrant(owner, ROLE_PERMISSIONS[roleKey]);
      }, `OWNER could not grant ${roleKey}`).not.toThrow();
    }
  });

  it('holds for every ordered pair of system roles: grantable iff subset', () => {
    // THE EXHAUSTIVE ARM, and the reason this is a unit test. 49 pairs, and the
    // expectation is derived from the same sets the function compares — so this
    // asserts the *rule*, not a table somebody transcribed.
    const roles = Object.keys(ROLE_PERMISSIONS) as (keyof typeof ROLE_PERMISSIONS)[];
    const disagreements: string[] = [];
    for (const actorRole of roles) {
      const held = new Set<Permission>(ROLE_PERMISSIONS[actorRole]);
      for (const grantedRole of roles) {
        const isSubset = ROLE_PERMISSIONS[grantedRole].every((permission) => held.has(permission));
        const error = caught(() => {
          assertActorMayGrant(actor(actorRole), ROLE_PERMISSIONS[grantedRole]);
        });
        const admitted = error === undefined;
        if (admitted !== isSubset) {
          disagreements.push(
            `${actorRole} granting ${grantedRole}: ${admitted ? 'admitted' : 'refused'}, ` +
              `expected ${isSubset ? 'admitted' : 'refused'}`,
          );
        }
      }
    }
    expect(disagreements).toEqual([]);
  });

  it('is not vacuous: at least one pair of system roles is genuinely refused', () => {
    // Carry-forward ruling 58. If every role held every permission the loop
    // above would pass while proving nothing, so the fixture set has to be
    // shown to sit on both sides of the branch.
    const roles = Object.keys(ROLE_PERMISSIONS) as (keyof typeof ROLE_PERMISSIONS)[];
    const refused = roles.flatMap((actorRole) =>
      roles.filter(
        (grantedRole) =>
          caught(() => {
            assertActorMayGrant(actor(actorRole), ROLE_PERMISSIONS[grantedRole]);
          }) !== undefined,
      ),
    );
    expect(refused.length).toBeGreaterThan(0);
  });

  it('ignores a granted key this build does not know as a permission', () => {
    // The seeded `Permission` rows are the source, and a row carrying a key
    // outside the published union cannot be compared against `ctx.permissions`
    // — which holds only known keys, because `knownPermissions` filters the
    // resolver's answer the same way. Refusing on it would make an unknown
    // seeded row deny every role change in the product; the contract's own
    // `z.enum(PERMISSIONS)` is what stops such a key reaching a client.
    expect(() => {
      assertActorMayGrant(actor('VIEWER'), ['not.a.real.permission']);
    }).not.toThrow();
  });

  it('admits an empty grant set', () => {
    expect(() => {
      assertActorMayGrant(actor('GUEST'), []);
    }).not.toThrow();
  });
});
