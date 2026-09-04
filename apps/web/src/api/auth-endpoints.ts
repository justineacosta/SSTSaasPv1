import {
  forgotPasswordResponseSchema,
  loginResponseSchema,
  mfaVerifyResponseSchema,
  registerResponseSchema,
  resendVerificationResponseSchema,
  resetPasswordResponseSchema,
  sessionResponseSchema,
  verifyEmailResponseSchema,
  type ForgotPasswordRequest,
  type ForgotPasswordResponse,
  type LoginRequest,
  type LoginResponse,
  type MfaVerifyRequest,
  type MfaVerifyResponse,
  type RegisterRequest,
  type RegisterResponse,
  type ResendVerificationRequest,
  type ResendVerificationResponse,
  type ResetPasswordRequest,
  type ResetPasswordResponse,
  type SessionResponse,
  type VerifyEmailRequest,
  type VerifyEmailResponse,
} from '@sentinel/contracts';
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
