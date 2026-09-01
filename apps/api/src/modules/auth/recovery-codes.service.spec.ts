import { describe, expect, it } from 'vitest';
import { PasswordService } from './password.service.js';
import {
  RECOVERY_CODE_ALPHABET,
  RECOVERY_CODE_BODY_LENGTH,
  RECOVERY_CODE_COUNT,
  RecoveryCodesService,
  looksLikeRecoveryCode,
  normaliseRecoveryCode,
} from './recovery-codes.service.js';

/**
 * Reduced Argon2 parameters, for `password.timing.spec.ts`'s reason:
 * `Argon2Parameters` comes from `apiEnvSchema` (carry-forward ruling 20)
 * precisely so a spec can run at a cost that is not production's. Every
 * property asserted here — the format, the count, single-use, the padded
 * verification count — is parameter-independent, and running ten production
 * verifications per test would cost this file about a minute.
 */
function service(): RecoveryCodesService {
  const passwords = new PasswordService({ memoryCostKib: 64, timeCost: 1, parallelism: 1 });
  return new RecoveryCodesService(passwords);
}

describe('generated recovery codes', () => {
  it('issues exactly ten', () => {
    expect(service().generate()).toHaveLength(RECOVERY_CODE_COUNT);
    expect(RECOVERY_CODE_COUNT).toBe(10);
  });

  it('is a set of ten distinct values', () => {
    expect(new Set(service().generate()).size).toBe(RECOVERY_CODE_COUNT);
  });

  it('renders as two groups a person can read off a screen', () => {
    const symbol = `[${RECOVERY_CODE_ALPHABET}]`;
    const shape = new RegExp(`^${symbol}{5}-${symbol}{5}$`);
    for (const code of service().generate()) expect(code).toMatch(shape);
  });

  it('leaves no confusable PAIR intact', () => {
    // A recovery code is typed from a printout under pressure, and an alphabet
    // containing BOTH members of a confusable pair turns a transcription slip
    // into a refusal the user cannot explain. Removing both members of a pair
    // costs entropy and buys nothing, so the assertion is about pairs and not
    // about a denylist of characters. `2`/`Z` and `5`/`S` are deliberately NOT
    // in this list — see the alphabet's own docblock.
    for (const [left, right] of [
      ['0', 'O'],
      ['1', 'I'],
      ['1', 'L'],
      ['I', 'L'],
    ]) {
      const both =
        RECOVERY_CODE_ALPHABET.includes(left ?? '') && RECOVERY_CODE_ALPHABET.includes(right ?? '');
      expect(both).toBe(false);
    }
  });

  it('is exactly 32 symbols, so each is worth a whole five bits', () => {
    expect(RECOVERY_CODE_ALPHABET).toHaveLength(32);
    expect(new Set(RECOVERY_CODE_ALPHABET).size).toBe(32);
  });

  it('carries fifty bits of entropy per code', () => {
    // 32 symbols is 5 bits each, ten symbols of body: 2^50. Asserted rather
    // than asserted-in-a-comment, so shortening the body fails a test.
    expect(RECOVERY_CODE_BODY_LENGTH).toBe(10);
    expect(Math.log2(RECOVERY_CODE_ALPHABET.length) * RECOVERY_CODE_BODY_LENGTH).toBe(50);
  });

  it('does not repeat across calls', () => {
    const first = new Set(service().generate());
    for (const code of service().generate()) expect(first.has(code)).toBe(false);
  });
});

describe('normaliseRecoveryCode', () => {
  it('accepts the code exactly as it is shown', () => {
    expect(normaliseRecoveryCode('ABCDE-FGHJK')).toBe('ABCDEFGHJK');
  });

  it('forgives case, the hyphen and surrounding or internal whitespace', () => {
    for (const typed of ['abcde-fghjk', 'ABCDEFGHJK', ' ABCDE FGHJK ', 'abcde fghjk']) {
      expect(normaliseRecoveryCode(typed)).toBe('ABCDEFGHJK');
    }
  });

  it('refuses anything that is not exactly ten alphabet characters', () => {
    for (const typed of ['', 'ABCDE', 'ABCDE-FGHJKL', '123456', 'ABCDE-FGHI0', 'ABCDE-FGH!K']) {
      expect(normaliseRecoveryCode(typed)).toBeNull();
    }
  });
});

describe('looksLikeRecoveryCode versus a TOTP code', () => {
  /**
   * D7. `mfa/verify` takes one `code` field and does not know which kind it is,
   * and the two paths cost wildly different amounts — one HMAC against ten
   * Argon2id verifications. The split is made on the SUBMITTED FORMAT, which
   * the caller already chose, rather than by trying both.
   *
   * The formats are disjoint on LENGTH: a TOTP code is exactly six characters
   * and a normalised recovery code is exactly ten. Nothing can be read as both,
   * and the property does not depend on the alphabets staying disjoint — which
   * a later edit to either could quietly break.
   */
  it('never reads a six-digit TOTP code as a recovery code', () => {
    for (const code of ['000000', '123456', '999999', '020202']) {
      expect(looksLikeRecoveryCode(code)).toBe(false);
    }
  });

  it('never reads a recovery code as six digits', () => {
    for (const code of service().generate()) {
      expect(code.replace('-', '')).not.toMatch(/^\d{6}$/);
      expect(looksLikeRecoveryCode(code)).toBe(true);
    }
  });
});

describe('matching a submitted recovery code against stored hashes', () => {
  it('finds the one code that matches and returns its id', async () => {
    const codes = service();
    const issued = codes.generate();
    const stored = await Promise.all(
      issued.map(async (code, index) => ({
        id: `rec_${String(index)}`,
        codeHash: await codes.hash(code),
      })),
    );

    expect(await codes.findMatch(issued[3] ?? '', stored)).toBe('rec_3');
    expect(await codes.findMatch(issued[9] ?? '', stored)).toBe('rec_9');
  });

  it('returns null for a code that was never issued', async () => {
    const codes = service();
    const issued = codes.generate();
    const stored = await Promise.all(
      issued.map(async (code, index) => ({
        id: `rec_${String(index)}`,
        codeHash: await codes.hash(code),
      })),
    );
    expect(await codes.findMatch('ZZZZZ-ZZZZZ', stored)).toBeNull();
  });

  it('returns null rather than throwing when the stored set is empty', async () => {
    expect(await service().findMatch('ABCDE-FGHJK', [])).toBeNull();
  });

  it('performs the same number of verifications however many codes remain', async () => {
    /**
     * D7'S ORACLE, CLOSED. Ten verifications ALWAYS, padded with
     * `PasswordService.verify(null, ...)` — carry-forward ruling 21's dummy,
     * which does a full Argon2id verification against a per-process dummy hash
     * and discards the result.
     *
     * Without the padding, a caller could count remaining recovery codes by
     * timing: a user with one code left answers roughly a tenth as slowly as
     * one with ten. That is a fact about somebody else's account state,
     * learnable by an attacker who has stolen a password and reached the MFA
     * challenge — exactly the party who wants to know whether the recovery set
     * is nearly spent.
     */
    const verifications: number[] = [];
    let calls = 0;
    const passwords = new PasswordService({ memoryCostKib: 64, timeCost: 1, parallelism: 1 });
    const originalVerify = passwords.verify.bind(passwords);
    passwords.verify = async (storedHash: string | null, password: string) => {
      calls += 1;
      return originalVerify(storedHash, password);
    };
    const counted = new RecoveryCodesService(passwords);

    for (const remaining of [0, 1, 5, 10]) {
      calls = 0;
      const issued = counted.generate().slice(0, remaining);
      const stored = await Promise.all(
        issued.map(async (code, index) => ({
          id: `rec_${String(index)}`,
          codeHash: await counted.hash(code),
        })),
      );
      calls = 0;
      expect(await counted.findMatch('ZZZZZ-ZZZZZ', stored)).toBeNull();
      verifications.push(calls);
    }

    expect(verifications).toEqual([
      RECOVERY_CODE_COUNT,
      RECOVERY_CODE_COUNT,
      RECOVERY_CODE_COUNT,
      RECOVERY_CODE_COUNT,
    ]);
  });

  it('refuses a value that is not recovery-shaped without touching a hash', async () => {
    // Cheap by design and it discloses nothing: the caller chose the shape of
    // what they submitted, and this answer is the same for every account.
    let calls = 0;
    const passwords = new PasswordService({ memoryCostKib: 64, timeCost: 1, parallelism: 1 });
    const originalVerify = passwords.verify.bind(passwords);
    passwords.verify = async (storedHash: string | null, password: string) => {
      calls += 1;
      return originalVerify(storedHash, password);
    };
    const counted = new RecoveryCodesService(passwords);

    expect(await counted.findMatch('123456', [{ id: 'rec_1', codeHash: 'x' }])).toBeNull();
    expect(calls).toBe(0);
  });
});

describe('hashing', () => {
  it('is Argon2id, not SHA-256', async () => {
    // A recovery code is 50 bits and human-typed. SHA-256 of a 50-bit value is
    // exhaustible offline; the work factor is the whole point. `schema.prisma`
    // says so and this pins it against the emitted PHC string rather than
    // against a comment.
    const codes = service();
    expect(await codes.hash('ABCDE-FGHJK')).toMatch(/^\$argon2id\$/);
  });

  it('normalises before hashing, so the stored hash matches what a user types', async () => {
    const codes = service();
    const hashed = await codes.hash('ABCDE-FGHJK');
    expect(await codes.findMatch('abcde fghjk', [{ id: 'rec_1', codeHash: hashed }])).toBe('rec_1');
  });
});
