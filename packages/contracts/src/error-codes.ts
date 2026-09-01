export const ERROR_CODES = {
  // Auth
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  MFA_REQUIRED: 'MFA_REQUIRED',
  MFA_INVALID: 'MFA_INVALID',
  // 403, not 401, and the distinction is the whole reason this is a separate
  // code from MFA_REQUIRED. MFA_REQUIRED means "you hold a pending session,
  // finish the challenge"; this means "you hold a FULL session and your
  // organisation will not let you use it until you enrol a factor". A 401 would
  // tell the frontend to show a sign-in form, which changes nothing — the
  // caller is already authenticated. Phase 2 Task 11 builds the mechanism that
  // raises it (`require-mfa.ts`); **Task 12 is what places that guard in the
  // pipeline**, so until then no shipped route can produce this.
  MFA_ENROLMENT_REQUIRED: 'MFA_ENROLMENT_REQUIRED',
  EMAIL_NOT_VERIFIED: 'EMAIL_NOT_VERIFIED',
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
  INVALID_API_KEY: 'INVALID_API_KEY',
  API_KEY_EXPIRED: 'API_KEY_EXPIRED',
  CSRF_TOKEN_INVALID: 'CSRF_TOKEN_INVALID',

  // Access
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  NOT_A_MEMBER: 'NOT_A_MEMBER',
  ORGANIZATION_SUSPENDED: 'ORGANIZATION_SUSPENDED',
  RESOURCE_NOT_FOUND: 'RESOURCE_NOT_FOUND',

  // Validation
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNKNOWN_FIELD: 'UNKNOWN_FIELD',
  INVALID_STATE_TRANSITION: 'INVALID_STATE_TRANSITION',
  VERSION_CONFLICT: 'VERSION_CONFLICT',
  DUPLICATE_RESOURCE: 'DUPLICATE_RESOURCE',
  // A policy refusal of a submitted value, not a failed authentication
  // attempt, which is why it sits here rather than in the Auth group above.
  // 422 (api/conventions.md §2: valid shape, failed a domain rule). ADR-0015.
  PASSWORD_BREACHED: 'PASSWORD_BREACHED',
  // ONE CODE FOR FOUR OUTCOMES, DELIBERATELY. A verification, reset or
  // invitation token that is unknown, expired, already consumed, or superseded
  // by a newer one all produce this and the same message. Splitting it would
  // make the consume endpoint an oracle: "expired" confirms the token once
  // existed, which confirms the address is registered, which is what
  // security/authentication.md §6's "response is identical whether or not the
  // address exists" forbids. 422 (api/conventions.md §2: valid shape, failed a
  // domain rule) — the token passed opaqueTokenSchema, it just is not
  // redeemable.
  TOKEN_INVALID: 'TOKEN_INVALID',

  // Domain — security testing
  SCOPE_VIOLATION: 'SCOPE_VIOLATION',
  ASSET_NOT_VERIFIED: 'ASSET_NOT_VERIFIED',
  ASSET_VERIFICATION_EXPIRED: 'ASSET_VERIFICATION_EXPIRED',
  TARGET_DENIED_BY_POLICY: 'TARGET_DENIED_BY_POLICY',
  PROFILE_NOT_PERMITTED: 'PROFILE_NOT_PERMITTED',
  ENGINE_NOT_AVAILABLE: 'ENGINE_NOT_AVAILABLE',
  SCAN_ALREADY_RUNNING: 'SCAN_ALREADY_RUNNING',
  SCAN_NOT_CANCELLABLE: 'SCAN_NOT_CANCELLABLE',

  // Entitlement
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  PLAN_LIMIT_REACHED: 'PLAN_LIMIT_REACHED',
  FEATURE_NOT_AVAILABLE: 'FEATURE_NOT_AVAILABLE',
  PAYMENT_REQUIRED: 'PAYMENT_REQUIRED',
  SUBSCRIPTION_INACTIVE: 'SUBSCRIPTION_INACTIVE',

  // Rate limit
  RATE_LIMITED: 'RATE_LIMITED',

  // Server
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  DEPENDENCY_UNAVAILABLE: 'DEPENDENCY_UNAVAILABLE',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export const ERROR_CODE_VALUES = Object.values(ERROR_CODES) as [ErrorCode, ...ErrorCode[]];
