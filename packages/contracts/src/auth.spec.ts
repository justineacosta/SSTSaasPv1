import { describe, expect, it } from 'vitest';
import type { ZodTypeAny } from 'zod';
import {
  changePasswordRequestSchema,
  emailSchema,
  forgotPasswordRequestSchema,
  loginRequestSchema,
  loginResponseSchema,
  logoutRequestSchema,
  mfaVerifyRequestSchema,
  passwordSchema,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  registerRequestSchema,
  resendVerificationRequestSchema,
  resetPasswordRequestSchema,
  sessionResponseSchema,
  switchOrganizationRequestSchema,
  verifyEmailRequestSchema,
} from './auth.js';

const VALID_PASSWORD = 'correcthorsebatterystaple';
const ORG_ID = 'org_01M0T74WZZFY9T2QS56RGF3GQ7';
const USER_ID = 'usr_01M0T74WZZFY9T2QS56RGF3GQ8';

describe('emailSchema', () => {
  it('trims and lower-cases at the boundary', () => {
    // User.email is @unique and Postgres does not case-fold for you. If the
    // boundary does not normalise, `Alice@Example.com` registers a SECOND
    // account beside `alice@example.com` and the unique constraint never
    // fires. This transform is the control, not a convenience.
    expect(emailSchema.parse('  Alice@Example.COM  ')).toBe('alice@example.com');
  });

  it('rejects a string that is not an email address', () => {
    expect(emailSchema.safeParse('alice@').success).toBe(false);
    expect(emailSchema.safeParse('not an address').success).toBe(false);
  });

  it('bounds the length', () => {
    expect(emailSchema.safeParse(`${'a'.repeat(250)}@example.com`).success).toBe(false);
  });
});

describe('passwordSchema', () => {
  it('accepts a 12-character all-lowercase password', () => {
    // THE RULE IS A FLOOR ON LENGTH AND NOTHING ELSE.
    // security/authentication.md §2: minimum 12, no composition rules — they
    // push users toward weaker, more predictable passwords. Anyone
    // "helpfully" adding a symbol or digit requirement sees this go red.
    expect(passwordSchema.parse('aaaaaaaaaaaa')).toBe('aaaaaaaaaaaa');
    expect(passwordSchema.safeParse('abcdefghijkl').success).toBe(true);
    expect(passwordSchema.safeParse('123456789012').success).toBe(true);
  });

  it('refuses 11 characters', () => {
    const result = passwordSchema.safeParse('a'.repeat(11));
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.code).toBe('too_small');
  });

  it('accepts 256 characters and refuses 257', () => {
    // The maximum bounds Argon2id's work, which rises with input length; an
    // unbounded password field is a cheap CPU-exhaustion vector.
    expect(passwordSchema.safeParse('a'.repeat(PASSWORD_MAX_LENGTH)).success).toBe(true);
    expect(passwordSchema.safeParse('a'.repeat(PASSWORD_MAX_LENGTH + 1)).success).toBe(false);
  });

  it('states the documented floor and the chosen ceiling', () => {
    expect(PASSWORD_MIN_LENGTH).toBe(12);
    expect(PASSWORD_MAX_LENGTH).toBe(256);
  });

  it('does not trim, because whitespace is a legitimate password character', () => {
    const padded = `  ${VALID_PASSWORD}  `;
    expect(passwordSchema.parse(padded)).toBe(padded);
  });
});

describe('every authentication request schema rejects unknown fields', () => {
  // api/conventions.md §3. This is the rule most easily lost to a later
  // refactor, so it is asserted for every schema at once rather than one at a
  // time — a new request schema added without `.strict()` is caught by adding
  // it to this table, and forgetting to add it is visible in review.
  const cases: [string, ZodTypeAny, Record<string, unknown>][] = [
    ['register', registerRequestSchema, { email: 'a@example.com', password: VALID_PASSWORD }],
    ['verify-email', verifyEmailRequestSchema, { token: 'tok' }],
    ['resend-verification', resendVerificationRequestSchema, { email: 'a@example.com' }],
    ['login', loginRequestSchema, { email: 'a@example.com', password: VALID_PASSWORD }],
    ['mfa/verify', mfaVerifyRequestSchema, { pendingToken: 'tok', code: '123456' }],
    ['logout', logoutRequestSchema, {}],
    ['switch-org', switchOrganizationRequestSchema, { organizationId: ORG_ID }],
    ['forgot-password', forgotPasswordRequestSchema, { email: 'a@example.com' }],
    ['reset-password', resetPasswordRequestSchema, { token: 'tok', password: VALID_PASSWORD }],
    [
      'change-password',
      changePasswordRequestSchema,
      { currentPassword: VALID_PASSWORD, newPassword: `${VALID_PASSWORD}2` },
    ],
  ];

  for (const [name, schema, valid] of cases) {
    it(`${name} accepts the documented body and rejects an extra key`, () => {
      expect(schema.safeParse(valid).success).toBe(true);

      const result = schema.safeParse({ ...valid, organisationId: 'typo' });
      expect(result.success).toBe(false);
      const issue = result.error?.issues[0];
      expect(issue?.code).toBe('unrecognized_keys');
      // The offending key is named, so the client can fix the spelling rather
      // than guess. This is the schema-level half of UNKNOWN_FIELD; the HTTP
      // half is ZodValidationPipe's.
      expect(issue?.code === 'unrecognized_keys' ? issue.keys : []).toEqual(['organisationId']);
    });
  }
});

describe('loginRequestSchema and rememberMe', () => {
  // Carry-forward ruling 18. The field is OPTIONAL, which is what makes it
  // additive under `api/conventions.md` §8: every client written against the
  // two-field body keeps working, and a client that wants a 30-day session
  // says so.
  it('accepts a body without rememberMe at all', () => {
    const parsed = loginRequestSchema.parse({ email: 'a@example.com', password: VALID_PASSWORD });
    expect('rememberMe' in parsed).toBe(false);
  });

  it('accepts rememberMe: true and rememberMe: false', () => {
    expect(
      loginRequestSchema.parse({
        email: 'a@example.com',
        password: VALID_PASSWORD,
        rememberMe: true,
      }).rememberMe,
    ).toBe(true);
    expect(
      loginRequestSchema.parse({
        email: 'a@example.com',
        password: VALID_PASSWORD,
        rememberMe: false,
      }).rememberMe,
    ).toBe(false);
  });

  it('refuses a non-boolean rememberMe rather than coercing it', () => {
    // A string `"false"` is truthy in JavaScript, so coercion here would turn
    // an explicit refusal of a long session into a thirty-day credential.
    expect(
      loginRequestSchema.safeParse({
        email: 'a@example.com',
        password: VALID_PASSWORD,
        rememberMe: 'false',
      }).success,
    ).toBe(false);
  });
});

describe('loginResponseSchema', () => {
  it('accepts the no-MFA shape', () => {
    expect(loginResponseSchema.parse({ mfaRequired: false })).toEqual({ mfaRequired: false });
  });

  it('accepts the MFA-required shape with a pending token', () => {
    expect(loginResponseSchema.parse({ mfaRequired: true, pendingToken: 'ptk' })).toEqual({
      mfaRequired: true,
      pendingToken: 'ptk',
    });
  });

  it('refuses mfaRequired: true without a pending token', () => {
    // A client that renders the MFA prompt has nothing to submit with.
    expect(loginResponseSchema.safeParse({ mfaRequired: true }).success).toBe(false);
  });

  it('strips a pending token from the no-MFA shape', () => {
    // api/authentication.md §2 has exactly two shapes. A pendingToken riding
    // along on a successful login is a credential handed to a caller that has
    // no use for it, so the contract drops it rather than passing it through.
    expect(loginResponseSchema.parse({ mfaRequired: false, pendingToken: 'leak' })).toEqual({
      mfaRequired: false,
    });
  });

  it('refuses a third shape', () => {
    expect(loginResponseSchema.safeParse({ mfaRequired: 'maybe' }).success).toBe(false);
    expect(loginResponseSchema.safeParse({}).success).toBe(false);
  });
});

describe('loginRequestSchema', () => {
  it('normalises the email through the shared schema', () => {
    const parsed = loginRequestSchema.parse({
      email: ' Alice@Example.com ',
      password: VALID_PASSWORD,
    });
    expect(parsed.email).toBe('alice@example.com');
  });

  it('applies the password floor, so a short password fails before Argon2id runs', () => {
    expect(
      loginRequestSchema.safeParse({ email: 'a@example.com', password: 'short' }).success,
    ).toBe(false);
  });
});

describe('sessionResponseSchema', () => {
  const base = {
    userId: USER_ID,
    activeOrganization: { id: ORG_ID, slug: 'acme', name: 'Acme' },
    permissions: ['finding.read'],
    entitlements: {},
  };

  it('accepts a session with an active organisation', () => {
    expect(sessionResponseSchema.parse(base).activeOrganization?.slug).toBe('acme');
  });

  it('accepts a null active organisation', () => {
    // A user may be signed in before choosing one — registration creates no
    // organisation.
    const parsed = sessionResponseSchema.parse({ ...base, activeOrganization: null });
    expect(parsed.activeOrganization).toBeNull();
  });

  it('requires the active organisation to be present, even when null', () => {
    // conventions.md §4: a field that exists is always present, even when
    // null. Absent means "not applicable", which is a different statement.
    const { activeOrganization, ...withoutOrg } = base;
    expect(activeOrganization).toBeDefined();
    expect(sessionResponseSchema.safeParse(withoutOrg).success).toBe(false);
  });

  it('refuses a permission that is not in the permission vocabulary', () => {
    expect(
      sessionResponseSchema.safeParse({ ...base, permissions: ['finding.obliterate'] }).success,
    ).toBe(false);
  });

  it('carries an entitlements placeholder', () => {
    expect(sessionResponseSchema.parse(base).entitlements).toEqual({});
  });
});
