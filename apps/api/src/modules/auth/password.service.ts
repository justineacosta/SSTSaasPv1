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
  /**
   * True when argon2 REFUSED TO READ the stored hash — carry-forward ruling 25,
   * closed by Task 9.
   *
   * This is an operational fault, not a failed login: the row in `Credential`
   * is corrupt, truncated, or written by something that is not this service.
   * Until now it was indistinguishable from a wrong password and produced no
   * signal at all, so an operator had no way to learn that a customer's
   * credential had rotted — the customer simply could not sign in and the logs
   * said nothing.
   *
   * **Reported rather than logged**, because this class has neither a logger
   * nor a user id and both are needed for a line worth reading.
   * `LoginService` writes it, at `error`, naming the user and no fragment of
   * the hash or the password (critical security rule 6).
   *
   * **It never changes what the caller sees on the wire.** `valid` is `false`
   * either way and the response is `INVALID_CREDENTIALS` either way. A
   * distinguishable refusal here would tell whoever is guessing that the
   * address is registered.
   *
   * **False when `storedHash` is `null`.** There is no stored credential to be
   * unreadable, and reporting one for an absent account would put the
   * account-existence distinction the dummy-hash path exists to erase back into
   * an operator's log.
   */
  readonly credentialUnreadable: boolean;
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
      // `credentialUnreadable: false` UNCONDITIONALLY on this path, and the
      // result of the dummy verification above is discarded as it always was.
      // The dummy is built by this process from live parameters, so it cannot
      // be corrupt in the way a stored row can; and if it somehow were, saying
      // so here would report "unreadable credential" for an account that does
      // not exist. See the field's docblock.
      return { valid: false, needsRehash: false, credentialUnreadable: false };
    }

    const outcome = await this.runVerification(storedHash, password);
    if (!outcome.ok) {
      return { valid: false, needsRehash: false, credentialUnreadable: outcome.unreadable };
    }
    return { valid: true, needsRehash: this.needsRehash(storedHash), credentialUnreadable: false };
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
   * thrown error's text is derived from the stored hash — so the ERROR is
   * swallowed rather than logged (critical security rule 6) and the attempt
   * simply fails.
   *
   * **What is no longer swallowed is the FACT that it happened.** Carry-forward
   * ruling 25: until Task 9 this catch discarded the only evidence anywhere in
   * the system that a credential row had rotted. The boolean below carries that
   * fact out — not the message, not the hash, not a fragment of either — and
   * `LoginService` turns it into one `error` line naming the user id.
   *
   * This is the only place that knows. A format check outside it is not
   * equivalent: a hash can parse cleanly as a v19 argon2id PHC string and still
   * be refused for a corrupt salt or digest, and `password.service.spec.ts`
   * asserts exactly that case.
   */
  private async runVerification(
    storedHash: string,
    password: string,
  ): Promise<{ ok: boolean; unreadable: boolean }> {
    try {
      return { ok: await argon2Verify(storedHash, password), unreadable: false };
    } catch {
      return { ok: false, unreadable: true };
    }
  }
}
