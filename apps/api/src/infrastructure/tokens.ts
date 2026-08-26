/**
 * Injection tokens for everything that is not a class.
 *
 * Strings rather than symbols so an unresolved dependency names itself in
 * Nest's error output instead of printing `Symbol(...)`, which is the
 * difference between a five-second and a five-minute diagnosis at boot.
 */
export const ENV = 'SENTINEL_ENV';
export const LOGGER = 'SENTINEL_LOGGER';
export const CSP_ENFORCE = 'SENTINEL_CSP_ENFORCE';
export const PRISMA = 'SENTINEL_PRISMA';
export const REDIS = 'SENTINEL_REDIS';
export const STORAGE = 'SENTINEL_STORAGE';
/** The `Mailer` port (ADR-0016). No caller knows what is behind it. */
export const MAILER = 'SENTINEL_MAILER';

/** The evidence bucket name, so a consumer that needs only that cannot reach a credential. */
export const EVIDENCE_BUCKET = 'SENTINEL_EVIDENCE_BUCKET';
