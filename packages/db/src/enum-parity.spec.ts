import { describe, expect, it } from 'vitest';
import { MEMBERSHIP_STATUSES, ORGANIZATION_STATUSES, SYSTEM_ROLES } from '@sentinel/contracts';
import { datamodelEnums, schemaStaleness } from './datamodel.js';

/**
 * THE PRISMA ENUMS AND THEIR WIRE RESTATEMENTS, HELD TOGETHER.
 *
 * `packages/contracts` must not depend on `packages/db` — the frontend imports
 * contracts with no Prisma client anywhere near it — so every enum that
 * crosses the wire is written out twice. `organizations.ts` and
 * `memberships.ts` each say the duplication is deliberate and must match.
 *
 * What they did NOT have until this spec was anything that noticed when it
 * stopped matching. Both contracts-side specs compare the constant to a
 * hard-coded literal in the same package: adding `ARCHIVED` to
 * `enum OrganizationStatus` in `schema.prisma` left every one of them green,
 * because nothing in that comparison had ever read `schema.prisma`. This spec
 * is the one that reads it, via the generated DMMF.
 *
 * Direction, as with `id-prefix-parity.spec.ts`: db -> contracts, never the
 * reverse. `packages/db` already depends on `@sentinel/contracts`; the reverse
 * dependency would be a cycle, which is why this lives here.
 *
 * It reads the DMMF through `./datamodel.js` rather than the generated client
 * directly, because that module is the one place allowed past the
 * `no-restricted-imports` fence around the client, and it exports schema shape
 * with nothing on it that can open a connection.
 */

/**
 * Prisma enum name -> the contracts constant that restates it.
 *
 * Adding an entry here is how an enum becomes "contracted". Removing the
 * contracts constant, renaming the Prisma enum, or changing either one's
 * values without the other turns this red.
 */
const CONTRACTED_ENUMS: Record<string, readonly string[]> = {
  OrganizationStatus: ORGANIZATION_STATUSES,
  MembershipStatus: MEMBERSHIP_STATUSES,
  SystemRoleKey: SYSTEM_ROLES,
};

/**
 * Enums that exist in the schema and deliberately have no wire restatement.
 *
 * Same contract as `DB_ONLY_PREFIXES`: the value is the reason, and the reason
 * is load-bearing. An enum parked here without one is how a value a client
 * needs to understand gets hidden to make a spec go green. Requiring every
 * enum to be contracted would force meaningless wire types for internal state
 * machines; requiring nothing would let a new enum arrive with no thought
 * about the client at all. The allowlist forces the thought once, out loud.
 */
const DB_ONLY_ENUMS: Record<string, string> = {
  UserStatus:
    'Account lifecycle state. Never returned to a client — enumeration resistance means a caller is not told whether an account is LOCKED or DISABLED.',
  SessionStatus:
    'PENDING_MFA vs ACTIVE is internal to the session machine. The wire says `mfaRequired: boolean` (authentication.md §2) instead.',
  MfaFactorType:
    'Factor types do not reach the wire. Task 11 shipped the MFA enrolment contracts and none of them names a factor type: the routes are TOTP-only by path, so there is nothing for a client to choose. WEBAUTHN is registered ahead of its implementation.',
  VerificationPurpose:
    'Chosen server-side from the endpoint being called; a client that could name the purpose could ask for a password-reset token by requesting email verification.',
  ActorType:
    'Audit-event actor kind. The audit query API is Phase 3; no contract carries an actor yet.',
};

const prismaEnums = datamodelEnums();
const prismaEnumsByName = new Map(prismaEnums.map((entry) => [entry.name, entry.values]));

/**
 * Compared as sorted lists, not in declaration order.
 *
 * Reordering an enum in `schema.prisma` changes nothing a client can observe —
 * these are string values, never ordinals — so a red on reordering alone would
 * be noise that trains the next person to "fix" it by reordering the contracts
 * array to match. What must never differ is the SET of values.
 */
const sorted = (values: readonly string[]): string[] => [...values].sort();

describe('Prisma enum parity with @sentinel/contracts', () => {
  it('restates every contracted enum with exactly the schema values', () => {
    for (const [enumName, contractValues] of Object.entries(CONTRACTED_ENUMS)) {
      const schemaValues = prismaEnumsByName.get(enumName);
      expect(schemaValues, `${enumName} is not an enum in schema.prisma`).toBeDefined();
      expect(sorted(contractValues), `${enumName} differs from its contracts restatement`).toEqual(
        sorted(schemaValues ?? []),
      );
    }
  });

  it('accounts for every schema enum — either a contract restatement or an allowlisted reason', () => {
    // Adding an enum to `schema.prisma` without adding a contract *or* a
    // reason turns this red. That is the whole point: the decision about
    // whether clients need to see it gets made once, deliberately, instead of
    // being discovered when a response carries a value the frontend cannot
    // parse.
    const unaccounted = prismaEnums
      .map((entry) => entry.name)
      .filter((name) => !(name in CONTRACTED_ENUMS) && !(name in DB_ONLY_ENUMS));
    expect(unaccounted).toEqual([]);
  });

  it('carries no allowlist entry for an enum that is now contracted or now gone', () => {
    // The allowlist must shrink when a contract arrives, or it becomes a list
    // of claims that used to be true.
    const stale = Object.keys(DB_ONLY_ENUMS).filter(
      (name) => name in CONTRACTED_ENUMS || !prismaEnumsByName.has(name),
    );
    expect(stale).toEqual([]);
  });

  it('gives every allowlist entry a non-empty reason', () => {
    for (const [name, reason] of Object.entries(DB_ONLY_ENUMS)) {
      expect(reason.length, `${name} has no reason`).toBeGreaterThan(0);
    }
  });

  it('reads a generated client that still matches schema.prisma on disk', () => {
    // `datamodelEnums()` reads the GENERATED client, not `schema.prisma`.
    // Editing an enum and not regenerating would leave every assertion above
    // comparing against the previous schema and reporting green — precisely
    // the false negative this file exists to remove. `schemaStaleness()`
    // returns undefined only when the generated copy hashes equal to the file
    // on disk, and fails closed on either being unreadable.
    expect(schemaStaleness()).toBeUndefined();
  });
});
