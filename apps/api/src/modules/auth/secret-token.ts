import { createHash, randomBytes } from 'node:crypto';

/**
 * LAYER 1 OF THE TOKEN DISCIPLINE: MINT AND HASH. NO TABLE, NO CLOCK, NO STATE.
 *
 * `security/authentication.md` §6 gives email verification, password reset and
 * invitation one discipline — 256-bit random, hashed at rest, single-use,
 * expiring, invalidated by use or by a newer token. The first two words of that
 * sentence are the whole of this file, and they are deliberately separated from
 * the persistence in `token.service.ts`, because the three kinds do not share a
 * table:
 *
 * - `VerificationToken` (`schema.prisma`) carries a **required** `userId` FK and
 *   a `purpose` whose Prisma enum has exactly two values.
 * - `Invitation` is tenant-owned and carries its own `tokenHash`; an invitee may
 *   have no `User` row at all.
 * - `Session.tokenHash` is a third table again.
 *
 * So the primitive is what all three share, and it is a pure function of
 * `node:crypto`. Task 6 (sessions) and Task 15 (invitations) call these two
 * functions and write their own rows; only `TokenService` below writes
 * `VerificationToken`.
 *
 * **This module has no notion of a Nest injection token.** `auth.tokens.ts`
 * next door holds those, and it means something completely different by the
 * word — every export here is named `SECRET_TOKEN_*` / `*SecretToken` so a
 * reader of an import list can tell a credential from a DI key.
 */

/**
 * 32 bytes = 256 bits, per §6.
 *
 * The number is exported so the spec asserts against the contract's figure
 * rather than against whatever the implementation happens to do.
 */
export const SECRET_TOKEN_BYTES = 32;

/**
 * 43 characters: `ceil(32 / 3) * 4` is 44 with one `=` of padding, which
 * base64url drops.
 *
 * Recorded because it is the fact that makes `opaqueTokenSchema`
 * (`packages/contracts/src/auth.ts`, `z.string().min(1).max(512)`) already
 * correct for this token — Task 2 left the issuing format to this task, and the
 * answer is that no contract change is owed.
 */
export const SECRET_TOKEN_ENCODED_LENGTH = 43;

/** A freshly minted token and the only part of it that may be persisted. */
export interface MintedSecretToken {
  /**
   * The raw secret. Returned to the caller exactly once, for the mailer.
   *
   * Never stored, never logged, never placed in an `AuditEvent`'s metadata,
   * never returned again. The field is named `token` on purpose: the redacting
   * logger in `@sentinel/observability` matches `token` as a key-name fragment,
   * so an accidental `logger.info({ ...minted })` is redacted structurally
   * rather than relying on a value-shape heuristic to notice.
   */
  readonly token: string;
  /** SHA-256 of `token`, hex. The only value a row ever holds. */
  readonly tokenHash: string;
}

/**
 * base64url rather than hex: the value goes in a URL query parameter, and
 * base64url is URL-safe without escaping while being a third shorter than hex
 * for the same entropy.
 */
export function mintSecretToken(): MintedSecretToken {
  const token = randomBytes(SECRET_TOKEN_BYTES).toString('base64url');
  return { token, tokenHash: hashSecretToken(token) };
}

/**
 * SHA-256, **not** Argon2id, and that is not an inconsistency with
 * `PasswordService`.
 *
 * Argon2id exists to make guessing a low-entropy human-chosen secret expensive.
 * There is nothing to guess here: the input is 256 bits of CSPRNG output, so an
 * offline attacker with the hash has no search space to slow down. What a
 * per-lookup Argon2 hash would buy instead is a memory-hard computation on the
 * request path of every verification link click, and a `tokenHash` that could
 * not be a unique index — a salted hash is different every time, so consumption
 * could no longer be the single conditional `UPDATE` that makes it atomic.
 * Recovery codes go the other way (Argon2id) precisely because they are short
 * and human-typed.
 */
export function hashSecretToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
