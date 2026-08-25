import { z } from 'zod';
import { organizationIdSchema, userIdSchema } from './ids.js';
import { PERMISSIONS } from './permissions.js';

/**
 * THE ONE EMAIL SCHEMA. Every contract that takes an address uses this.
 *
 * `.trim().toLowerCase()` is a security control, not tidiness. `User.email` is
 * `@unique` and Postgres does not case-fold a `text` column for you, so
 * `Alice@Example.com` and `alice@example.com` are two different rows: without
 * this transform a second account registers beside the first and the unique
 * constraint never fires. Normalising at the boundary means every write below
 * is already in one canonical form.
 *
 * The length bound is RFC 5321's 254-character limit on a full address. An
 * unbounded string at an unauthenticated endpoint is free memory for a caller.
 */
export const emailSchema = z.string().trim().toLowerCase().email().max(254);

/**
 * PASSWORD POLICY: A FLOOR ON LENGTH AND NOTHING ELSE.
 *
 * security/authentication.md §2: minimum 12 characters, no composition rules,
 * no forced rotation — both push users toward weaker, more predictable
 * passwords. There is deliberately no digit, symbol or mixed-case requirement
 * here, and `auth.spec.ts` asserts that a 12-character all-lowercase password
 * is accepted so that anyone "helpfully" adding one sees a test go red.
 *
 * The maximum is 256. §2 says "no maximum below 128", which is a floor on the
 * maximum rather than the maximum itself: 128 exactly would refuse a real
 * generated passphrase, and no maximum at all hands an attacker a cheap
 * Argon2id CPU-exhaustion vector, because hashing cost rises with input length.
 * 256 satisfies the documented floor and bounds the cost.
 *
 * NOT trimmed, unlike `emailSchema`. Leading and trailing whitespace is
 * legitimate password material; trimming it would silently change what the
 * user typed and lock them out of an account they created elsewhere.
 */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;
export const passwordSchema = z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH);

/**
 * A single-use secret handed to the caller by email and posted back.
 *
 * Deliberately validated only as a bounded, non-empty string. The issuing
 * format — 256-bit random, base64url — belongs to the token service (Task 4),
 * and pinning it in a client-facing schema here would make a later change to
 * that format a breaking API change for no gain. What this schema is for is
 * refusing an empty or absurd value before it reaches a database lookup.
 */
export const opaqueTokenSchema = z.string().min(1).max(512);

/**
 * The response shape for endpoints whose body `api/authentication.md` does not
 * document.
 *
 * §2 documents login, mfa/verify, logout, session and switch-org precisely.
 * Registration, verification, resend, forgot, reset and change are named by the
 * Phase 2 plan but their bodies are documented nowhere — and several of them
 * are deliberately contentless, because the enumeration-resistance rule
 * requires the response to be identical whether or not the account exists.
 *
 * So each gets the minimal honest shape its described behaviour requires: a
 * single constant status literal. Constant is the point — a field whose value
 * never varies with the account cannot leak whether the account exists. The
 * task named against each one below owns widening it if it ever needs more,
 * and widening a response is additive under `api/conventions.md` §8 while
 * narrowing is not, which is why the small shape is the safe direction now.
 */
function statusResponseSchema<TStatus extends string>(status: TStatus) {
  return z.object({ status: z.literal(status) });
}

// --- Registration and email verification (Task 8 owns refining these) -------

export const registerRequestSchema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
    name: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

/**
 * Identical for an address that already exists and one that does not — same
 * status, same body. An existing address receives a "someone tried to register
 * with your address" email instead of a verification link, which is the only
 * place the two paths differ, and it is not on the wire.
 */
export const registerResponseSchema = statusResponseSchema('VERIFICATION_REQUIRED');

export const verifyEmailRequestSchema = z.object({ token: opaqueTokenSchema }).strict();
export const verifyEmailResponseSchema = statusResponseSchema('EMAIL_VERIFIED');

export const resendVerificationRequestSchema = z.object({ email: emailSchema }).strict();
/** Deliberately the same body as `registerResponseSchema`, for the same reason. */
export const resendVerificationResponseSchema = statusResponseSchema('VERIFICATION_REQUIRED');

// --- Login, MFA, logout, session, switch-org (api/authentication.md §2) -----

/**
 * `{ email, password }`, exactly as §2 documents it.
 *
 * There is no `rememberMe` field yet, although `Session.rememberMe` exists in
 * the schema. Adding an OPTIONAL field to a `.strict()` request schema is
 * additive under `api/conventions.md` §8; removing one is not. So the task that
 * actually implements the 30-day session (Task 9) adds it, rather than this
 * task guessing a name that `check:openapi` would then pin.
 */
export const loginRequestSchema = z
  .object({ email: emailSchema, password: passwordSchema })
  .strict();

/**
 * EXACTLY THE TWO SHAPES IN §2 AND NOTHING ELSE.
 *
 * A discriminated union rather than one object with an optional `pendingToken`,
 * because the optional version lets a client forget to check `mfaRequired` and
 * still typecheck — and the failure mode of that mistake is a UI that treats a
 * half-authenticated login as complete. Here the token is unreachable without
 * first narrowing on the discriminant.
 *
 * Neither arm is `.strict()` — response schemas are not — so the success arm
 * STRIPS a stray `pendingToken` rather than passing it through. That is the
 * behaviour we want: a pending credential has no business riding along on a
 * login that already succeeded.
 */
export const loginResponseSchema = z.discriminatedUnion('mfaRequired', [
  z.object({ mfaRequired: z.literal(false) }),
  z.object({ mfaRequired: z.literal(true), pendingToken: z.string().min(1) }),
]);

/**
 * The pending token can do exactly one thing: complete MFA (§2).
 *
 * `code` is NOT narrowed to six digits. Task 11's `mfa/verify` accepts a TOTP
 * code *or* a recovery code, and recovery codes are longer and not numeric —
 * narrowing here would reject every recovery code at the boundary, before any
 * handler saw it, which is precisely when a user is least able to work around
 * it. The bound is a sanity bound, not a format.
 *
 * MFA *enrolment* — start, confirm, disable, regenerate — has no contract in
 * this file on purpose. `api/authentication.md` documents none of it, and
 * Task 11 owns those shapes; inventing them here would pin a guess into the
 * committed OpenAPI document before the endpoint exists.
 */
export const mfaVerifyRequestSchema = z
  .object({ pendingToken: opaqueTokenSchema, code: z.string().trim().min(1).max(64) })
  .strict();
export const mfaVerifyResponseSchema = statusResponseSchema('AUTHENTICATED');

/**
 * Logout takes no body and returns 204. The schema exists so that a body with
 * anything in it is rejected rather than ignored — an empty `.strict()` object
 * is the only shape that says "nothing goes here" in a way the pipe enforces.
 */
export const logoutRequestSchema = z.object({}).strict();

/** The organisation a session is currently acting in. */
export const sessionOrganizationSchema = z.object({
  id: organizationIdSchema,
  slug: z.string(),
  name: z.string(),
});

/**
 * `GET /api/v1/auth/session` — "current principal, org, permissions,
 * entitlements" (§2). The permission-aware frontend reads this and nothing
 * else, which is why the effective permission set is on it rather than being
 * something the client derives from a role name.
 *
 * NOT a serialisation of `Principal`. That type is internal and holds a session
 * ID, which has no business being readable by a script running in the page.
 * The wire representation of a session is this, deliberately.
 *
 * `activeOrganization` is nullable and always present: a user may be signed in
 * before choosing an organisation, and `conventions.md` §4 distinguishes null
 * ("no active organisation") from absent ("not applicable here").
 *
 * `entitlements` is a placeholder. Billing is Phase 5 and owns its real shape;
 * an open record is honest about that, where a guessed set of keys would be a
 * shape `check:openapi` pins before anything can populate it.
 */
export const sessionResponseSchema = z.object({
  userId: userIdSchema,
  activeOrganization: sessionOrganizationSchema.nullable(),
  permissions: z.array(z.enum(PERMISSIONS)),
  entitlements: z.record(z.unknown()),
});

export const switchOrganizationRequestSchema = z
  .object({ organizationId: organizationIdSchema })
  .strict();

/**
 * §2: switch-org returns "the new session context" — the same document the
 * session endpoint returns, now describing the organisation just switched to.
 * One shape, so a client can reuse one parser and one piece of state.
 */
export const switchOrganizationResponseSchema = sessionResponseSchema;

// --- Password reset and change (Task 10 owns refining these) ----------------

export const forgotPasswordRequestSchema = z.object({ email: emailSchema }).strict();
/** Identical whether or not the address exists. That is the whole contract. */
export const forgotPasswordResponseSchema = statusResponseSchema('RESET_REQUESTED');

export const resetPasswordRequestSchema = z
  .object({ token: opaqueTokenSchema, password: passwordSchema })
  .strict();
export const resetPasswordResponseSchema = statusResponseSchema('PASSWORD_RESET');

/**
 * The current password is required. Changing a password from a stolen session
 * without proving the old one is an account-takeover step, not a settings edit.
 */
export const changePasswordRequestSchema = z
  .object({ currentPassword: passwordSchema, newPassword: passwordSchema })
  .strict();
export const changePasswordResponseSchema = statusResponseSchema('PASSWORD_CHANGED');

export type RegisterRequest = z.infer<typeof registerRequestSchema>;
export type RegisterResponse = z.infer<typeof registerResponseSchema>;
export type VerifyEmailRequest = z.infer<typeof verifyEmailRequestSchema>;
export type VerifyEmailResponse = z.infer<typeof verifyEmailResponseSchema>;
export type ResendVerificationRequest = z.infer<typeof resendVerificationRequestSchema>;
export type ResendVerificationResponse = z.infer<typeof resendVerificationResponseSchema>;
export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type LoginResponse = z.infer<typeof loginResponseSchema>;
export type MfaVerifyRequest = z.infer<typeof mfaVerifyRequestSchema>;
export type MfaVerifyResponse = z.infer<typeof mfaVerifyResponseSchema>;
export type LogoutRequest = z.infer<typeof logoutRequestSchema>;
export type SessionOrganization = z.infer<typeof sessionOrganizationSchema>;
export type SessionResponse = z.infer<typeof sessionResponseSchema>;
export type SwitchOrganizationRequest = z.infer<typeof switchOrganizationRequestSchema>;
export type SwitchOrganizationResponse = z.infer<typeof switchOrganizationResponseSchema>;
export type ForgotPasswordRequest = z.infer<typeof forgotPasswordRequestSchema>;
export type ForgotPasswordResponse = z.infer<typeof forgotPasswordResponseSchema>;
export type ResetPasswordRequest = z.infer<typeof resetPasswordRequestSchema>;
export type ResetPasswordResponse = z.infer<typeof resetPasswordResponseSchema>;
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;
export type ChangePasswordResponse = z.infer<typeof changePasswordResponseSchema>;
