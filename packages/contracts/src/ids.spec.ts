import { describe, expect, it } from 'vitest';
import {
  ID_SCHEMA_PREFIXES,
  identityProviderLinkIdSchema,
  idSchema,
  invitationIdSchema,
  membershipIdSchema,
  mfaFactorIdSchema,
  organizationIdSchema,
  recoveryCodeIdSchema,
  sessionIdSchema,
  userIdSchema,
  verificationTokenIdSchema,
} from './ids.js';

/** A body of the right length drawn only from the Crockford alphabet. */
const BODY = '01M0T74WZZFY9T2QS56RGF3GQ7';

describe('idSchema', () => {
  it('accepts a well-formed prefixed identifier', () => {
    expect(idSchema('fnd').parse(`fnd_${BODY}`)).toBe(`fnd_${BODY}`);
  });

  it('rejects the right body under the wrong prefix', () => {
    expect(idSchema('fnd').safeParse(`scn_${BODY}`).success).toBe(false);
  });

  it('rejects a body containing a letter the Crockford alphabet excludes', () => {
    // I, L, O and U are excluded to stop transcription errors. A schema that
    // accepted them would accept an ID `newId()` can never produce.
    expect(idSchema('org').safeParse(`org_${BODY.slice(0, 25)}U`).success).toBe(false);
  });

  it('rejects a body of the wrong length', () => {
    expect(idSchema('org').safeParse(`org_${BODY.slice(0, 25)}`).success).toBe(false);
  });
});

describe('ID_SCHEMA_PREFIXES', () => {
  it('is the single source of truth every *IdSchema is derived from', () => {
    // If a schema were declared with a hand-written literal instead of being
    // derived from this map, the map could be edited without the schema
    // following. Each pair below is asserted through the schema, not through
    // the map, so the derivation is what is under test.
    const cases: [string, { safeParse: (value: string) => { success: boolean } }][] = [
      [ID_SCHEMA_PREFIXES.organization, organizationIdSchema],
      [ID_SCHEMA_PREFIXES.user, userIdSchema],
      [ID_SCHEMA_PREFIXES.membership, membershipIdSchema],
      [ID_SCHEMA_PREFIXES.invitation, invitationIdSchema],
      [ID_SCHEMA_PREFIXES.session, sessionIdSchema],
      [ID_SCHEMA_PREFIXES.mfaFactor, mfaFactorIdSchema],
      [ID_SCHEMA_PREFIXES.verificationToken, verificationTokenIdSchema],
      [ID_SCHEMA_PREFIXES.recoveryCode, recoveryCodeIdSchema],
      [ID_SCHEMA_PREFIXES.identityProviderLink, identityProviderLinkIdSchema],
    ];

    for (const [prefix, schema] of cases) {
      expect(schema.safeParse(`${prefix}_${BODY}`).success).toBe(true);
      expect(schema.safeParse(`xxx_${BODY}`).success).toBe(false);
    }
  });

  it('names the identity prefixes Phase 2 introduced', () => {
    expect(ID_SCHEMA_PREFIXES.session).toBe('ses');
    expect(ID_SCHEMA_PREFIXES.mfaFactor).toBe('mfa');
    expect(ID_SCHEMA_PREFIXES.verificationToken).toBe('vtk');
    expect(ID_SCHEMA_PREFIXES.recoveryCode).toBe('rcv');
    expect(ID_SCHEMA_PREFIXES.identityProviderLink).toBe('idp');
  });

  it('uses three characters for every prefix', () => {
    // `parseIdPrefix` in @sentinel/db matches `[a-z]{3}`. A four-character
    // prefix here would produce IDs that package cannot parse — which is why
    // IdentityProviderLink is `idp` and not `idpl`.
    for (const prefix of Object.values(ID_SCHEMA_PREFIXES)) {
      expect(prefix).toMatch(/^[a-z]{3}$/);
    }
  });

  it('has no duplicate prefixes', () => {
    const values = Object.values(ID_SCHEMA_PREFIXES);
    expect(new Set(values).size).toBe(values.length);
  });
});
