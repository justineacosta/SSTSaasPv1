/**
 * Injection tokens local to the auth module.
 *
 * Strings rather than symbols, for the same reason as
 * `infrastructure/tokens.ts`: an unresolved dependency names itself in Nest's
 * boot error instead of printing `Symbol(...)`.
 */
export const ARGON2_PARAMETERS = 'SENTINEL_ARGON2_PARAMETERS';
export const BREACH_CHECK_OPTIONS = 'SENTINEL_BREACH_CHECK_OPTIONS';
export const HIBP_RANGE_TRANSPORT = 'SENTINEL_HIBP_RANGE_TRANSPORT';
