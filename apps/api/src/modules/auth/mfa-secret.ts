import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { TOTP_SECRET_BYTES } from './totp.js';

/**
 * AES-256-GCM for `MfaFactor.secretEncrypted` — the only field in Phase 2 that
 * is encrypted rather than hashed.
 *
 * `schema.prisma` says why, and it is not a preference: verifying a TOTP code
 * means **recomputing** it from the shared secret, so a one-way hash cannot
 * work here. Every other credential in this phase — passwords, session tokens,
 * verification tokens, recovery codes — is hashed, and this is the one
 * exception.
 *
 * # GCM, not CBC, and the auth tag is stored
 *
 * The ciphertext is authenticated. Without that, a database write that flipped
 * a bit would decrypt to *different plausible bytes*, and the failure mode
 * would be a user whose authenticator suddenly produces wrong codes with
 * nothing anywhere saying why. Under GCM the same corruption is a refusal.
 *
 * # One string, not four columns
 *
 * `<keyVersion>.<iv>.<authTag>.<ciphertext>`, each part base64url. Spreading
 * the parts across columns invites a partial write, and a self-describing
 * envelope means a future format can be introduced without a migration: an
 * unknown version is refused rather than misread.
 *
 * # `secretKeyVersion` stops being dead weight here
 *
 * Carry-forward ruling 8: the column has existed since Task 1 and nothing wrote
 * it. Every row this module seals carries version `1` **explicitly**, in the
 * envelope and in the column, and the decrypt path reads the column, treating
 * `NULL` as `1` for the rows Task 1's docblock described. A disagreement
 * between the two is a refusal, not a guess — a half-completed re-encryption is
 * exactly when guessing decrypts with the wrong key and returns bytes that look
 * like a secret.
 *
 * # Nothing here logs, and no error carries the material
 *
 * Critical security rule 6. `MfaSecretError` carries a constant string: an
 * exception raised by `node:crypto` on a failed authentication derives from the
 * key and the ciphertext, and both are exactly what must not reach a log or an
 * error body. `mfa-secret.spec.ts` asserts that on the raised error rather than
 * trusting the redacting logger, which carry-forward ruling 67 records is a
 * value-shape net rather than a field-name denylist.
 */

/**
 * The key version every row written from now on carries.
 *
 * A constant rather than configuration: the version is a property of the key
 * material this process holds, and an operator who rotates the key changes both
 * together. When a second key exists this becomes a lookup, and the decrypt
 * path below is already shaped for it — it refuses a version it holds no key
 * for instead of assuming there is only one.
 */
export const CURRENT_MFA_SECRET_KEY_VERSION = 1;

/** 96 bits, the IV length GCM is specified and optimised for. Random per encryption. */
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const ENVELOPE_PARTS = 4;

/**
 * One refusal for every way a stored secret can fail to open.
 *
 * The message is a constant and names nothing. A caller cannot distinguish a
 * tampered body from a wrong key from a malformed envelope, and it does not
 * need to: all three mean the same thing operationally — this row cannot be
 * used to verify a code — and the difference between them is derived from
 * material that must not be described.
 */
export class MfaSecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MfaSecretError';
  }
}

/**
 * 20 bytes, which is RFC 4226 §4's recommended length and the HMAC-SHA1 block
 * size. Longer buys nothing — HMAC-SHA1 folds a key longer than 64 bytes and
 * pads a shorter one — and shorter is a weaker shared secret.
 */
export function generateTotpSecret(): Buffer {
  return randomBytes(TOTP_SECRET_BYTES);
}

export interface SealedMfaSecret {
  readonly ciphertext: string;
  readonly keyVersion: number;
}

export function encryptMfaSecret(key: Buffer, plaintext: Uint8Array): SealedMfaSecret {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    ciphertext: [
      String(CURRENT_MFA_SECRET_KEY_VERSION),
      iv.toString('base64url'),
      tag.toString('base64url'),
      body.toString('base64url'),
    ].join('.'),
    keyVersion: CURRENT_MFA_SECRET_KEY_VERSION,
  };
}

/**
 * `storedKeyVersion` is `MfaFactor.secretKeyVersion`, which is nullable.
 *
 * `null` means version 1 — Task 1's docblock defined it as "the application key
 * that was current when this row was written", and there has only ever been
 * one. Task 11 writes the column on every row it creates, so `null` is a
 * legacy value that no row in any database actually holds; the branch exists
 * because a rotation story that cannot read its own oldest rows is not a
 * rotation story.
 */
export function decryptMfaSecret(
  key: Buffer,
  ciphertext: string,
  storedKeyVersion: number | null,
): Buffer {
  const parts = ciphertext.split('.');
  if (parts.length !== ENVELOPE_PARTS) {
    throw new MfaSecretError('The stored MFA secret could not be decrypted.');
  }

  const envelopeVersion = Number(parts[0]);
  if (!Number.isInteger(envelopeVersion)) {
    throw new MfaSecretError('The stored MFA secret could not be decrypted.');
  }

  // The column and the envelope must agree. They disagree only when a
  // re-encryption wrote one and not the other, and continuing from a guess
  // would decrypt with the wrong key and hand back bytes that look like a
  // secret — a factor that silently stops matching the user's phone.
  if ((storedKeyVersion ?? CURRENT_MFA_SECRET_KEY_VERSION) !== envelopeVersion) {
    throw new MfaSecretError(
      'The stored MFA secret names a key version that does not match its row.',
    );
  }
  if (envelopeVersion !== CURRENT_MFA_SECRET_KEY_VERSION) {
    throw new MfaSecretError('The stored MFA secret names a key version this process cannot use.');
  }

  const iv = Buffer.from(parts[1] ?? '', 'base64url');
  const tag = Buffer.from(parts[2] ?? '', 'base64url');
  const body = Buffer.from(parts[3] ?? '', 'base64url');
  // Length-checked before `createDecipheriv`, which throws its own errors whose
  // text describes the material. Refusing here keeps every failure on one path
  // with one constant message.
  if (iv.length !== IV_BYTES || tag.length !== AUTH_TAG_BYTES) {
    throw new MfaSecretError('The stored MFA secret could not be decrypted.');
  }

  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    // SWALLOWED DELIBERATELY. The thrown error derives from the key and the
    // ciphertext (critical security rule 6), and every reason it can be raised
    // — a wrong key, a flipped bit, a truncated row — means the same thing to
    // every caller.
    throw new MfaSecretError('The stored MFA secret could not be decrypted.');
  }
}
