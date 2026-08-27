import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * THE CSRF TOKEN, DERIVED FROM THE SESSION TOKEN RATHER THAN STORED.
 *
 * `security/authentication.md` §4 requires a double-submit token "bound to the
 * session". Three ways to bind one were available:
 *
 * 1. **A column on `Session`.** Needs a migration, and Task 6's ruling 32 note
 *    records what opening one costs. It also needs rotation to remember to
 *    rotate it, and forgetting is silent.
 * 2. **An HMAC over the session id with an application key.** Needs a new
 *    secret in configuration — one more thing to provision, rotate and leak.
 * 3. **An HMAC keyed by the session token itself**, which is what this is.
 *
 * The third has no storage, no new secret, and binds by construction: the key
 * *is* the credential, so a token derived for one session cannot validate
 * another, and a rotated session derives a new CSRF token with no extra step
 * because `rotate` mints a new session token.
 *
 * **The session token is the key, not the message.** HMAC rather than a plain
 * `sha256(token + suffix)` because SHA-256 is length-extendable: knowing
 * `sha256(secret || m)` lets an attacker compute `sha256(secret || m || pad ||
 * m2)`. No verifier here would accept such a value, so the plain hash would
 * have been safe in this use — but "safe because nothing happens to consume it"
 * is a property of today's callers, not of the primitive, and HMAC costs the
 * same.
 *
 * **What the CSRF cookie leaking does and does not give an attacker.** The
 * cookie is deliberately not `HttpOnly` — page script has to read it to set the
 * header — so it must be safe in the hands of anything that can read the DOM.
 * It is a 256-bit HMAC output: it does not reveal the session token, and it is
 * useless without the session cookie, which is `HttpOnly` and never leaves the
 * browser's control. An attacker who has both has the session, and CSRF stopped
 * being the relevant control.
 */

/**
 * The HMAC message. Constant, and versioned in its own text.
 *
 * The version is here rather than in the cookie's name so that changing the
 * derivation invalidates every outstanding CSRF token without renaming a cookie
 * — the browser keeps sending the old name, the derived value no longer
 * matches, and the next safe request re-issues it.
 */
const CSRF_DERIVATION_MESSAGE = 'sentinel.csrf.v1';

/** 43 characters: 32 bytes of HMAC-SHA256 in base64url, padding dropped. */
export const CSRF_TOKEN_ENCODED_LENGTH = 43;

/** base64url so the value is a legal cookie octet and a legal header value. */
export function deriveCsrfToken(sessionToken: string): string {
  return createHmac('sha256', sessionToken).update(CSRF_DERIVATION_MESSAGE).digest('base64url');
}

/**
 * Whether a presented CSRF token is the one this session's token derives.
 *
 * **Both sides are hashed to a fixed 32 bytes before comparison, and that is
 * the point.** `crypto.timingSafeEqual` throws a `RangeError` when its
 * arguments differ in length — so the naive implementation either leaks the
 * expected length through a thrown 500 versus a returned 403, or reintroduces
 * the early-exit comparison the function exists to remove. Hashing first makes
 * length not a branch at all: every input, of any length or encoding, becomes
 * 32 bytes.
 *
 * SHA-256 rather than a length check plus `timingSafeEqual`, because a length
 * check is itself a branch on attacker-controlled input, and because the digest
 * also removes the question of what `Buffer.from(value, 'utf8')` does to a
 * header carrying bytes outside base64url.
 */
export function csrfTokenMatches(presented: string, sessionToken: string): boolean {
  if (presented === '') return false;

  const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();
  return timingSafeEqual(digest(presented), digest(deriveCsrfToken(sessionToken)));
}
