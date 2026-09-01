import { randomInt } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { PasswordService } from './password.service.js';

/**
 * `security/authentication.md` §5's ten single-use recovery codes.
 *
 * # The format is chosen for a person reading a printout under pressure
 *
 * `XXXXX-XXXXX` over a 32-symbol alphabet with **no confusable pair left
 * intact**. Ten symbols of body at five bits each is **fifty bits** per code,
 * which is the number that has to survive the threat model below.
 *
 * The alphabet drops `I`, `L` and `O` and keeps `0`, which reads backwards
 * until you say the rule out loud: what matters is that no *pair* survives, not
 * that every character somebody has ever mistyped is absent. `O` is gone, so a
 * `0` cannot be read as anything else in the set; `I` and `L` are gone, so `1`
 * would be unambiguous too and is dropped only to land the alphabet on exactly
 * 32 symbols, which is what makes each one worth a whole five bits. Removing
 * both members of a pair costs entropy and buys nothing.
 *
 * A recovery code is used exactly when the user has lost their phone, which is
 * the worst possible moment to discover that `RECOVERY-CODE-l1I0O` cannot be
 * typed correctly. The hyphen is cosmetic and the parser ignores it, along with
 * case and whitespace.
 *
 * # Argon2id, and fifty bits is why
 *
 * `schema.prisma` and the phase plan both require Argon2id here rather than the
 * SHA-256 used for session and verification tokens, and the reason is the
 * entropy. A 256-bit random token is not brute-forceable whatever it is hashed
 * with; fifty bits under SHA-256 is roughly a thousand trillion guesses, which
 * is a weekend on rented hardware for anyone holding a database dump. Under
 * Argon2id at ADR-0014's parameters it is not.
 *
 * It uses `PasswordService` rather than a second Argon2 configuration, so a
 * parameter an operator raises applies here too. There is deliberately no
 * `needsRehash` path: a recovery code is single-use and short-lived by
 * intention, so upgrading its stored parameters is work with no beneficiary.
 *
 * # TEN VERIFICATIONS PER SUBMITTED CODE, ALWAYS, AND THAT IS THE DESIGN
 *
 * A submitted recovery code cannot be looked up — the stored value is a salted
 * Argon2id hash, so there is no index to probe. Every unused code has to be
 * tried. That is up to ten verifications, and at ADR-0014's ~250 ms target it
 * is the most expensive path in the authentication surface.
 *
 * Three things bound it and one closes an oracle:
 *
 * - **The two kinds of code are told apart by format, not by trying both.** A
 *   TOTP code is exactly six characters and a recovery code is exactly ten, so
 *   the sets are disjoint on LENGTH alone — not on an alphabet argument that a
 *   later edit to either could quietly break. `mfa/verify` runs one path or the
 *   other and never both.
 * - **The verifications are sequential**, not `Promise.all`. Ten parallel
 *   Argon2id verifications at 64 MiB each is 640 MiB of peak memory for one
 *   request, which is a memory-exhaustion vector wearing a latency
 *   optimisation's clothes.
 * - **A match stops the loop**, so the expensive full run is the failure case,
 *   which is also the rate-limited one.
 * - **A failure always costs exactly ten**, padded with
 *   `PasswordService.verify(null, ...)` — carry-forward ruling 21's dummy.
 *   Without the padding, response time would count the codes a user has left:
 *   one remaining answers roughly a tenth as slowly as ten. That is a fact
 *   about somebody else's account, and the party who would want it is precisely
 *   the one who has stolen a password and reached the MFA challenge.
 *
 * **The timing distinction that remains is between the two KINDS of code, and
 * it is caller-chosen.** A six-digit submission costs one HMAC and a
 * ten-symbol one costs ten Argon2id verifications. The caller decided which to
 * send, the difference is the same for every account, and it reveals nothing
 * about the user, the factor, or how many codes are left. It is a real
 * distinction and it is not an oracle; see this task's report.
 */

/**
 * 32 symbols, five bits each: the upper-case letters without `I`, `L` and `O`,
 * plus the digits without `1`. See the class docblock for why `0` stays.
 *
 * `2`/`Z` and `5`/`S` both survive, deliberately. They are confusable in some
 * handwriting and in very few printed faces; removing either pair would drop
 * the alphabet below 32 symbols and cost every code a fraction of a bit, which
 * is a worse trade than the transcription risk on a value that is displayed,
 * not written out.
 */
export const RECOVERY_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ023456789';
export const RECOVERY_CODE_BODY_LENGTH = 10;
export const RECOVERY_CODE_GROUP_LENGTH = 5;
export const RECOVERY_CODE_COUNT = 10;

/**
 * Strips the presentation and returns the ten symbols, or `null`.
 *
 * `null` means "this is not a recovery code", not "this recovery code is
 * wrong". The caller uses it to choose a path, so it must be a shape question
 * and never a secret one — nothing here compares against anything stored.
 */
export function normaliseRecoveryCode(submitted: string): string | null {
  const stripped = submitted.replace(/[\s-]/g, '').toUpperCase();
  if (stripped.length !== RECOVERY_CODE_BODY_LENGTH) return null;
  for (const character of stripped) {
    if (!RECOVERY_CODE_ALPHABET.includes(character)) return null;
  }
  return stripped;
}

export function looksLikeRecoveryCode(submitted: string): boolean {
  return normaliseRecoveryCode(submitted) !== null;
}

/** The shape `mfa/verify` reads out of `RecoveryCode`. Never the `usedAt`. */
export interface StoredRecoveryCode {
  readonly id: string;
  readonly codeHash: string;
}

@Injectable()
export class RecoveryCodesService {
  constructor(@Inject(PasswordService) private readonly passwords: PasswordService) {}

  /**
   * Ten distinct codes, in the form shown to the user exactly once.
   *
   * `randomInt` rather than `randomBytes` modulo the alphabet length. The
   * alphabet is 32 symbols today, so a modulo would happen to be unbiased — and
   * that is exactly the kind of correctness that stops being true when somebody
   * removes one confusable character. `randomInt` rejects and re-draws, so the
   * uniformity is a property of the draw rather than of the current length.
   *
   * Distinctness is enforced rather than assumed. The chance of a collision in
   * ten draws from 2^50 is about 4 x 10^-14, so the loop is not a performance
   * concern; it is here because two identical codes in a set of ten silently
   * costs the user one of their ten.
   */
  generate(): string[] {
    const codes = new Set<string>();
    while (codes.size < RECOVERY_CODE_COUNT) codes.add(this.oneCode());
    return [...codes];
  }

  private oneCode(): string {
    let body = '';
    for (let index = 0; index < RECOVERY_CODE_BODY_LENGTH; index += 1) {
      body += RECOVERY_CODE_ALPHABET[randomInt(RECOVERY_CODE_ALPHABET.length)];
    }
    return `${body.slice(0, RECOVERY_CODE_GROUP_LENGTH)}-${body.slice(RECOVERY_CODE_GROUP_LENGTH)}`;
  }

  /**
   * Hashes the NORMALISED form, so what is stored is what a user's typing
   * normalises to rather than what happened to be printed.
   *
   * A value that is not recovery-shaped is hashed as-is. That path is
   * unreachable from any caller here — everything hashed by this service came
   * out of `generate()` — and throwing would turn a programming error into a
   * 500 on the enrolment path.
   */
  async hash(code: string): Promise<string> {
    return this.passwords.hash(normaliseRecoveryCode(code) ?? code);
  }

  async hashAll(codes: readonly string[]): Promise<string[]> {
    const hashes: string[] = [];
    // Sequential, for the memory reason in the class docblock: ten parallel
    // Argon2id hashes at 64 MiB each is 640 MiB of peak RSS for one request.
    for (const code of codes) hashes.push(await this.hash(code));
    return hashes;
  }

  /**
   * The id of the stored code the submission matches, or `null`.
   *
   * **It does not mark anything used.** Consuming a code is a conditional
   * `UPDATE` inside the caller's transaction — see
   * `mfa-verification.service.ts` — because "find it" and "spend it" happening
   * in two statements with no predicate between them is how the same code gets
   * accepted twice under concurrency.
   */
  async findMatch(
    submitted: string,
    stored: readonly StoredRecoveryCode[],
  ): Promise<string | null> {
    const normalised = normaliseRecoveryCode(submitted);
    // No verification at all for a value that is not recovery-shaped. See the
    // class docblock: the caller chose the shape and the answer does not vary
    // by account.
    if (normalised === null) return null;

    let verifications = 0;
    for (const candidate of stored.slice(0, RECOVERY_CODE_COUNT)) {
      verifications += 1;
      if ((await this.passwords.verify(candidate.codeHash, normalised)).valid) return candidate.id;
    }

    // THE PADDING IS THE CONTROL. Ruling 21's dummy path performs a full
    // Argon2id verification against a per-process dummy hash and discards the
    // result, so a user with two codes left costs the same as one with ten.
    while (verifications < RECOVERY_CODE_COUNT) {
      verifications += 1;
      await this.passwords.verify(null, normalised);
    }
    return null;
  }
}
