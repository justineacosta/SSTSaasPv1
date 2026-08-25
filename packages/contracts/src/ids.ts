import { z } from 'zod';

/**
 * Client-facing ID validation. Clients must not parse IDs (api/conventions.md
 * §1); this schema exists so the API can reject a malformed one at the boundary
 * rather than passing it to the database.
 */
const ID_BODY = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function idSchema(prefix: string) {
  return z
    .string()
    .refine(
      (value) => value.startsWith(`${prefix}_`) && ID_BODY.test(value.slice(prefix.length + 1)),
      { message: `Expected an identifier beginning with "${prefix}_".` },
    );
}

/**
 * THE ONE PLACE A CLIENT-FACING PREFIX IS WRITTEN DOWN.
 *
 * Every `*IdSchema` below is derived from this map rather than repeating a
 * literal, so a prefix can only be wrong here, once, instead of being wrong in
 * one schema and right in the others.
 *
 * It is exported because it is half of a pair. `@sentinel/db`'s `ID_PREFIXES`
 * is the *generator* side, and until Phase 2 the two lists were independent
 * with no cross-check — and had already drifted. `packages/db` carries
 * `id-prefix-parity.spec.ts`, which imports this map and fails when either side
 * gains a prefix the other does not know about, modulo an explicitly named
 * allowlist of db-only prefixes. The dependency runs db -> contracts and must
 * never run the other way, which is why that spec lives there and not here.
 *
 * NOT named `ID_PREFIXES`: `@sentinel/db` already exports that name from its
 * own index, and a file importing both packages would have to rename one of
 * them at every call site.
 *
 * Every prefix is three characters, because `parseIdPrefix` in `@sentinel/db`
 * matches `[a-z]{3}`. That is why `IdentityProviderLink` is `idp`, not `idpl`.
 */
export const ID_SCHEMA_PREFIXES = {
  organization: 'org',
  user: 'usr',
  membership: 'mbr',
  invitation: 'inv',
  session: 'ses',
  mfaFactor: 'mfa',
  verificationToken: 'vtk',
  recoveryCode: 'rcv',
  identityProviderLink: 'idp',
} as const;

export type IdSchemaEntity = keyof typeof ID_SCHEMA_PREFIXES;

export const organizationIdSchema = idSchema(ID_SCHEMA_PREFIXES.organization);
export const userIdSchema = idSchema(ID_SCHEMA_PREFIXES.user);
export const membershipIdSchema = idSchema(ID_SCHEMA_PREFIXES.membership);
export const invitationIdSchema = idSchema(ID_SCHEMA_PREFIXES.invitation);
export const sessionIdSchema = idSchema(ID_SCHEMA_PREFIXES.session);
export const mfaFactorIdSchema = idSchema(ID_SCHEMA_PREFIXES.mfaFactor);
export const verificationTokenIdSchema = idSchema(ID_SCHEMA_PREFIXES.verificationToken);
export const recoveryCodeIdSchema = idSchema(ID_SCHEMA_PREFIXES.recoveryCode);
export const identityProviderLinkIdSchema = idSchema(ID_SCHEMA_PREFIXES.identityProviderLink);
