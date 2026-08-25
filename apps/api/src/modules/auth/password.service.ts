import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  hash as argon2Hash,
  hashSync as argon2HashSync,
  verify as argon2Verify,
} from '@node-rs/argon2';
import { ARGON2_PARAMETERS } from './auth.tokens.js';

/**
 * `Algorithm.Argon2id` as a plain number.
 *
 * `@node-rs/argon2` declares `Algorithm` as an **ambient `const enum`**
 * (`@node-rs/argon2/index.d.ts`), and `tsconfig.base.json` sets
 * `isolatedModules: true`, under which a value import of an ambient const enum
 * is a compile error — there is no runtime object to read the member from. The
 * numeric value is part of the published declaration (`Argon2id = 2`), and it
 * is pinned by a spec that asserts the `$argon2id$` tag in the emitted PHC
 * string rather than trusting this constant.
 */
const ARGON2ID = 2;

/**
 * Argon2id cost parameters, supplied by configuration rather than fixed in
 * code. ADR-0014: `security/authentication.md` §2's m=64MiB / t=3 / p=4 is
 * explicitly a *starting point* to be tuned on production hardware, and a
 * parameter an operator can raise without a build is the whole reason
 * `needsRehash` below has anything to do.
 */
export interface Argon2Parameters {
  readonly memoryCostKib: number;
  readonly timeCost: number;
  readonly parallelism: number;
}

export interface PasswordVerification {
  readonly valid: boolean;
  /**
   * True only when `valid` is also true. The caller rehashes transparently on
   * the next *successful* login; reporting it on a failed verification would
   * invite a caller to rehash a password it just rejected.
   */
  readonly needsRehash: boolean;
}

/**
 * Reads the cost parameters back out of an Argon2 PHC string.
 *
 * `$argon2id$v=19$m=65536,t=3,p=4$<salt>$<digest>` — the format is
 * self-describing, which is what lets a stored hash be compared against
 * today's configuration at all, and what makes ADR-0014's "the library is
 * replaceable without a data migration" true.
 *
 * Returns `null` for anything that is not a v19 argon2id PHC string, including
 * a well-formed argon2i or argon2d one. A credential stored under a different
 * algorithm is not weaker-parameter argon2id; it is something this service did
 * not write, and `verify` treats it as needing replacement.
 */
export function parseArgon2Phc(phc: string): Argon2Parameters | null {
  const fields = phc.split('$');
  // ['', 'argon2id', 'v=19', 'm=..,t=..,p=..', salt, digest]
  if (fields.length !== 6) return null;
  if (fields[0] !== '') return null;
  if (fields[1] !== 'argon2id') return null;
  if (fields[2] !== 'v=19') return null;

  const costs = new Map<string, number>();
  for (const pair of (fields[3] ?? '').split(',')) {
    const [key, rawValue] = pair.split('=');
    if (key === undefined || rawValue === undefined) return null;
    if (!/^\d+$/.test(rawValue)) return null;
    costs.set(key, Number(rawValue));
  }

  const memoryCostKib = costs.get('m');
  const timeCost = costs.get('t');
  const parallelism = costs.get('p');
  if (memoryCostKib === undefined || timeCost === undefined || parallelism === undefined) {
    return null;
  }
  return { memoryCostKib, timeCost, parallelism };
}

interface Argon2Options {
  readonly memoryCost: number;
  readonly timeCost: number;
  readonly parallelism: number;
  readonly algorithm: number;
}

/**
 * Argon2id hashing, and the one verification entry point the rest of the
 * application is allowed to use.
 *
 * The `storedHash: string | null` parameter of `verify` is the design, not a
 * convenience. `security/authentication.md` §2 requires login timing to be
 * equal whether or not the account exists, and the only way to keep that true
 * is to make the safe path the *only* path: a caller cannot express "no such
 * user, skip the hash" without deliberately not calling this function.
 */
@Injectable()
export class PasswordService {
  /**
   * The hash a non-existent account is verified against.
   *
   * Built once, here, **from the parameters this service was constructed
   * with** — not a hard-coded constant. A dummy baked at different parameters
   * than the live ones costs a different amount of time to verify, which is a
   * timing oracle wearing a mitigation's name.
   *
   * The input is random per process rather than a literal, so no user can pick
   * the string this compares against. `hashSync` blocks: this is one
   * synchronous Argon2id hash during Nest's provider construction, on a
   * process that is not yet serving requests.
   */
  private readonly dummyHash: string;

  constructor(@Inject(ARGON2_PARAMETERS) private readonly parameters: Argon2Parameters) {
    this.dummyHash = argon2HashSync(randomBytes(32).toString('base64url'), this.options());
  }

  private options(): Argon2Options {
    return {
      memoryCost: this.parameters.memoryCostKib,
      timeCost: this.parameters.timeCost,
      parallelism: this.parameters.parallelism,
      algorithm: ARGON2ID,
    };
  }

  /** Returns a PHC string that embeds the parameters it was produced with. */
  async hash(password: string): Promise<string> {
    return argon2Hash(password, this.options());
  }

  /**
   * Verifies `password` against `storedHash`, performing exactly one full
   * Argon2id verification either way.
   *
   * When `storedHash` is `null` — no such user, or a user with no password
   * credential — the verification runs against `dummyHash` and its result is
   * discarded. The work is the point.
   */
  async verify(storedHash: string | null, password: string): Promise<PasswordVerification> {
    if (storedHash === null) {
      await this.runVerification(this.dummyHash, password);
      return { valid: false, needsRehash: false };
    }

    const valid = await this.runVerification(storedHash, password);
    if (!valid) return { valid: false, needsRehash: false };
    return { valid: true, needsRehash: this.needsRehash(storedHash) };
  }

  /**
   * True when the stored hash is weaker than current configuration on any
   * axis, or is not a v19 argon2id PHC string at all.
   *
   * Deliberately one-directional: a hash that is *stronger* than current
   * configuration is left alone. Rehashing it would silently downgrade a
   * credential because an operator lowered a number, which is the opposite of
   * what this mechanism exists for.
   */
  private needsRehash(storedHash: string): boolean {
    const stored = parseArgon2Phc(storedHash);
    if (stored === null) return true;
    return (
      stored.memoryCostKib < this.parameters.memoryCostKib ||
      stored.timeCost < this.parameters.timeCost ||
      stored.parallelism < this.parameters.parallelism
    );
  }

  /**
   * `verify` throws on a malformed hash rather than returning false. A stored
   * credential that will not parse is a database-integrity problem, and the
   * thrown error's text is derived from the stored hash — so it is swallowed
   * rather than logged (critical security rule 6) and the attempt simply
   * fails.
   */
  private async runVerification(storedHash: string, password: string): Promise<boolean> {
    try {
      return await argon2Verify(storedHash, password);
    } catch {
      return false;
    }
  }
}
