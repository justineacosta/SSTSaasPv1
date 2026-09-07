import {
  changePasswordResponseSchema,
  forgotPasswordResponseSchema,
  loginResponseSchema,
  mfaDisableResponseSchema,
  mfaEnrollResponseSchema,
  mfaRecoveryCodesResponseSchema,
  mfaVerifyResponseSchema,
  registerResponseSchema,
  resendVerificationResponseSchema,
  resetPasswordResponseSchema,
  revokeOtherSessionsResponseSchema,
  revokeSessionResponseSchema,
  sessionCollectionSchema,
  sessionResponseSchema,
  switchOrganizationResponseSchema,
  verifyEmailResponseSchema,
  type ChangePasswordRequest,
  type ChangePasswordResponse,
  type ForgotPasswordRequest,
  type ForgotPasswordResponse,
  type LoginRequest,
  type LoginResponse,
  type MfaConfirmRequest,
  type MfaDisableRequest,
  type MfaDisableResponse,
  type MfaEnrollRequest,
  type MfaEnrollResponse,
  type MfaRecoveryCodesResponse,
  type MfaRegenerateRecoveryCodesRequest,
  type MfaVerifyRequest,
  type MfaVerifyResponse,
  type RegisterRequest,
  type RegisterResponse,
  type ResendVerificationRequest,
  type ResendVerificationResponse,
  type ResetPasswordRequest,
  type ResetPasswordResponse,
  type RevokeOtherSessionsResponse,
  type RevokeSessionResponse,
  type SessionCollection,
  type SessionResponse,
  type SwitchOrganizationRequest,
  type SwitchOrganizationResponse,
  type VerifyEmailRequest,
  type VerifyEmailResponse,
} from '@sentinel/contracts';
import { z } from 'zod';
import type { ApiClient } from './client';

/**
 * The eight authentication endpoints, each bound to the contract schema its
 * response must satisfy.
 *
 * Request types come from `packages/contracts` too, so the request shape a
 * screen builds and the shape the API's pipe validates are the same
 * declaration. Nothing in `apps/web` re-declares a field.
 *
 * The paths are string literals in exactly one place. Verified against the
 * published surface on 2026-09-04:
 * `node -e "const o=require('./apps/api/openapi.json');console.log(Object.keys(o.paths))"`
 * lists all eight.
 */
const AUTH = '/api/v1/auth';

export function register(client: ApiClient, body: RegisterRequest): Promise<RegisterResponse> {
  return client.request({
    method: 'POST',
    path: `${AUTH}/register`,
    body,
    responseSchema: registerResponseSchema,
  });
}

export function verifyEmail(
  client: ApiClient,
  body: VerifyEmailRequest,
  signal?: AbortSignal,
): Promise<VerifyEmailResponse> {
  return client.request({
    method: 'POST',
    path: `${AUTH}/verify-email`,
    body,
    responseSchema: verifyEmailResponseSchema,
    ...(signal === undefined ? {} : { signal }),
  });
}

export function resendVerification(
  client: ApiClient,
  body: ResendVerificationRequest,
): Promise<ResendVerificationResponse> {
  return client.request({
    method: 'POST',
    path: `${AUTH}/resend-verification`,
    body,
    responseSchema: resendVerificationResponseSchema,
  });
}

export function login(client: ApiClient, body: LoginRequest): Promise<LoginResponse> {
  return client.request({
    method: 'POST',
    path: `${AUTH}/login`,
    body,
    responseSchema: loginResponseSchema,
  });
}

export function verifyMfa(client: ApiClient, body: MfaVerifyRequest): Promise<MfaVerifyResponse> {
  return client.request({
    method: 'POST',
    path: `${AUTH}/mfa/verify`,
    body,
    responseSchema: mfaVerifyResponseSchema,
  });
}

export function forgotPassword(
  client: ApiClient,
  body: ForgotPasswordRequest,
): Promise<ForgotPasswordResponse> {
  return client.request({
    method: 'POST',
    path: `${AUTH}/forgot-password`,
    body,
    responseSchema: forgotPasswordResponseSchema,
  });
}

export function resetPassword(
  client: ApiClient,
  body: ResetPasswordRequest,
): Promise<ResetPasswordResponse> {
  return client.request({
    method: 'POST',
    path: `${AUTH}/reset-password`,
    body,
    responseSchema: resetPasswordResponseSchema,
  });
}

/**
 * The only safe method here, and the one that must NOT carry the CSRF header —
 * `client.request` decides that from the method, which is what
 * `client.spec.ts` asserts in both directions.
 */
export function fetchSession(client: ApiClient, signal?: AbortSignal): Promise<SessionResponse> {
  return client.request({
    method: 'GET',
    path: `${AUTH}/session`,
    responseSchema: sessionResponseSchema,
    ...(signal === undefined ? {} : { signal }),
  });
}

/**
 * A 204 has no body, so there is nothing for a response schema to parse.
 *
 * `client.request` requires one on every call — deliberately, so a response can
 * never be cast — and `z.undefined()` is how "this endpoint answers nothing" is
 * said in that vocabulary. It is not a contract shape and is therefore not
 * imported from `packages/contracts`: it describes the absence of one.
 */
const noContentSchema = z.undefined();

export function logout(client: ApiClient): Promise<undefined> {
  return client.request({
    method: 'POST',
    path: `${AUTH}/logout`,
    body: {},
    responseSchema: noContentSchema,
  });
}

export function switchOrganization(
  client: ApiClient,
  body: SwitchOrganizationRequest,
): Promise<SwitchOrganizationResponse> {
  return client.request({
    method: 'POST',
    path: `${AUTH}/switch-org`,
    body,
    responseSchema: switchOrganizationResponseSchema,
  });
}

/**
 * One page of the caller's own live sessions.
 *
 * The query is built here rather than by the screen so the limit and the cursor
 * cannot be spelled two ways. `limit` is omitted when absent rather than sent
 * as `undefined`, which would serialise to the string "undefined".
 */
export function listSessions(
  client: ApiClient,
  query: { limit?: number; cursor?: string } = {},
  signal?: AbortSignal,
): Promise<SessionCollection> {
  const search = new URLSearchParams();
  if (query.limit !== undefined) search.set('limit', String(query.limit));
  if (query.cursor !== undefined) search.set('cursor', query.cursor);
  const suffix = search.size === 0 ? '' : `?${search.toString()}`;

  return client.request({
    method: 'GET',
    path: `${AUTH}/sessions${suffix}`,
    responseSchema: sessionCollectionSchema,
    ...(signal === undefined ? {} : { signal }),
  });
}

export function revokeSession(
  client: ApiClient,
  sessionId: string,
): Promise<RevokeSessionResponse> {
  return client.request({
    method: 'DELETE',
    // `sessionId` comes from a response this client parsed with
    // `sessionIdSchema`, so it is already known to be 26 characters of
    // Crockford base32 behind a `ses_` prefix. Encoded anyway: a path segment
    // built by interpolation is the shape that goes wrong the day the value
    // comes from somewhere else.
    path: `${AUTH}/sessions/${encodeURIComponent(sessionId)}`,
    responseSchema: revokeSessionResponseSchema,
  });
}

export function revokeOtherSessions(client: ApiClient): Promise<RevokeOtherSessionsResponse> {
  return client.request({
    method: 'DELETE',
    path: `${AUTH}/sessions`,
    responseSchema: revokeOtherSessionsResponseSchema,
  });
}

export function changePassword(
  client: ApiClient,
  body: ChangePasswordRequest,
): Promise<ChangePasswordResponse> {
  return client.request({
    method: 'POST',
    path: `${AUTH}/change-password`,
    body,
    responseSchema: changePasswordResponseSchema,
  });
}

export function enrollMfa(client: ApiClient, body: MfaEnrollRequest): Promise<MfaEnrollResponse> {
  return client.request({
    method: 'POST',
    path: `${AUTH}/mfa/enroll`,
    body,
    responseSchema: mfaEnrollResponseSchema,
  });
}

export function confirmMfa(
  client: ApiClient,
  body: MfaConfirmRequest,
): Promise<MfaRecoveryCodesResponse> {
  return client.request({
    method: 'POST',
    path: `${AUTH}/mfa/confirm`,
    body,
    responseSchema: mfaRecoveryCodesResponseSchema,
  });
}

export function disableMfa(
  client: ApiClient,
  body: MfaDisableRequest,
): Promise<MfaDisableResponse> {
  return client.request({
    method: 'POST',
    path: `${AUTH}/mfa/disable`,
    body,
    responseSchema: mfaDisableResponseSchema,
  });
}

export function regenerateRecoveryCodes(
  client: ApiClient,
  body: MfaRegenerateRecoveryCodesRequest,
): Promise<MfaRecoveryCodesResponse> {
  return client.request({
    method: 'POST',
    path: `${AUTH}/mfa/recovery-codes`,
    body,
    responseSchema: mfaRecoveryCodesResponseSchema,
  });
}
