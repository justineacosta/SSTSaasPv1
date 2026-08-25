/**
 * Injection tokens local to the auth module.
 *
 * Strings rather than symbols, for the same reason as
 * `infrastructure/tokens.ts`: an unresolved dependency names itself in Nest's
 * boot error instead of printing `Symbol(...)`.
 *
 * **"Token" means a Nest DI key in this file and nowhere else in this module.**
 * `secret-token.ts` and `token.service.ts` next door mean a secret credential
 * by it — a verification link, a reset link, an invitation. Nothing here is or
 * holds a credential; `SECRET_TOKEN_TTL_SECONDS` is the DI key under which the
 * three configured lifetimes are provided, and the `SECRET_TOKEN_` prefix is
 * what keeps the two senses apart in an import list.
 */
export const ARGON2_PARAMETERS = 'SENTINEL_ARGON2_PARAMETERS';
export const BREACH_CHECK_OPTIONS = 'SENTINEL_BREACH_CHECK_OPTIONS';
export const HIBP_RANGE_TRANSPORT = 'SENTINEL_HIBP_RANGE_TRANSPORT';
export const SECRET_TOKEN_TTL_SECONDS = 'SENTINEL_SECRET_TOKEN_TTL_SECONDS';
