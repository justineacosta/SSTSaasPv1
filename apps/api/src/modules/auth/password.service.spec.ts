import { describe, expect, it } from 'vitest';
import { type Argon2Parameters, parseArgon2Phc, PasswordService } from './password.service.js';

/**
 * Deliberately small parameters. Every assertion in this file is about which
 * numbers are embedded in a PHC string and how they compare, which is
 * independent of how expensive the numbers are.
 *
 * ~250ms is the tuning *target* in `security/authentication.md` §2, not a cost
 * anything here has measured; ADR-0014 records the target as untuned. Measured
 * 2026-08-25 on the development machine (Windows 11 x64, Node v26.7.0, 12
 * logical CPUs), the configured defaults cost 37.4 ms per `hashSync` and
 * 36.0 ms per verification. Measured for this file specifically, same date and
 * machine: it runs in **146 ms** at the parameters below, and **1288 ms** when
 * every parameter set in it is crudely substituted with the configured
 * defaults. So real parameters would cost about a second here — not
 * prohibitive, and the reduction is a CI-headroom choice on a shared runner
 * rather than a local necessity. The production starting point (m=64MiB, t=3,
 * p=4) is fixed in `apiEnvSchema`'s defaults, and `env.spec.ts` is where that
 * is asserted.
 */
const WEAK: Argon2Parameters = { memoryCostKib: 1024, timeCost: 1, parallelism: 1 };
const CURRENT: Argon2Parameters = { memoryCostKib: 8192, timeCost: 2, parallelism: 1 };

const PASSWORD = 'correct horse battery staple';

describe('PasswordService rehashing', () => {
  it('flags a hash made at weaker parameters and replaces it at the current ones', async () => {
    // ADR-0014: `needsRehash` is the mechanism that makes "the parameters can
    // be raised later" a real operation rather than an aspiration. Without it
    // every stored hash stays pinned to the parameters in force on the day the
    // account was created.
    const weakService = new PasswordService(WEAK);
    const storedHash = await weakService.hash(PASSWORD);
    expect(parseArgon2Phc(storedHash)).toEqual(WEAK);

    // The operator raises the configured parameters. Same stored hash, new service.
    const raisedService = new PasswordService(CURRENT);
    const result = await raisedService.verify(storedHash, PASSWORD);
    expect(result).toEqual({ valid: true, needsRehash: true });

    // ...and the caller's transparent rehash actually replaces it.
    const replacement = await raisedService.hash(PASSWORD);
    expect(replacement).not.toEqual(storedHash);
    expect(parseArgon2Phc(replacement)).toEqual(CURRENT);
    expect(await raisedService.verify(replacement, PASSWORD)).toEqual({
      valid: true,
      needsRehash: false,
    });
  });

  it('does not flag a hash made at the current parameters', async () => {
    // The negative half, and it is not a formality: a `needsRehash` that is
    // always true rehashes on every single login. At the production target of
    // ~250ms that is a per-request tax, and no positive-only test would ever
    // see it.
    const service = new PasswordService(CURRENT);
    const storedHash = await service.hash(PASSWORD);
    expect(await service.verify(storedHash, PASSWORD)).toEqual({
      valid: true,
      needsRehash: false,
    });
  });

  // Each row differs from its raised service on EXACTLY the named axis, and the
  // rows are written as explicit stored/raised pairs for that reason. An
  // earlier version compared every row against one raised service of
  // {8192, 2, 2}, so the memory-cost and time-cost rows also differed on
  // parallelism and passed on that clause alone — deleting either of the other
  // two comparisons from `needsRehash` left the whole unit project green
  // (review 3c5d694, finding F1, mutations E and F). A test whose title claims
  // independence has to be independent.
  it.each([
    [
      'a lower memory cost',
      { memoryCostKib: 4096, timeCost: 2, parallelism: 1 },
      { memoryCostKib: 8192, timeCost: 2, parallelism: 1 },
    ],
    [
      'a lower time cost',
      { memoryCostKib: 8192, timeCost: 1, parallelism: 1 },
      { memoryCostKib: 8192, timeCost: 2, parallelism: 1 },
    ],
    [
      'a lower parallelism',
      { memoryCostKib: 8192, timeCost: 2, parallelism: 1 },
      { memoryCostKib: 8192, timeCost: 2, parallelism: 2 },
    ],
  ])(
    'flags %s independently of the other two axes',
    async (_name, weaker: Argon2Parameters, raised: Argon2Parameters) => {
      const stored = await new PasswordService(weaker).hash(PASSWORD);
      expect(await new PasswordService(raised).verify(stored, PASSWORD)).toEqual({
        valid: true,
        needsRehash: true,
      });
    },
  );

  it('leaves a hash stronger than current configuration alone', async () => {
    // Lowering a configured parameter must never rewrite an existing
    // credential downwards. `needsRehash` is one-directional by design.
    const stored = await new PasswordService(CURRENT).hash(PASSWORD);
    const lowered = new PasswordService(WEAK);
    expect(await lowered.verify(stored, PASSWORD)).toEqual({ valid: true, needsRehash: false });
  });
});

describe('PasswordService.hash', () => {
  it('emits a v19 argon2id PHC string carrying its own parameters', async () => {
    // This is what pins `ARGON2ID = 2` in password.service.ts, which cannot
    // import the library's ambient `const enum` under `isolatedModules`. If
    // the numeric value ever stopped meaning Argon2id, this assertion breaks
    // rather than the constant silently selecting Argon2d.
    const phc = await new PasswordService(CURRENT).hash(PASSWORD);
    expect(phc.startsWith('$argon2id$v=19$m=8192,t=2,p=1$')).toBe(true);
  });

  it('salts, so the same password twice produces two different hashes', async () => {
    const service = new PasswordService(CURRENT);
    expect(await service.hash(PASSWORD)).not.toEqual(await service.hash(PASSWORD));
  });

  it('accepts the longest password the contract permits', async () => {
    // `passwordSchema` in @sentinel/contracts is `.min(12).max(256)`; the
    // ceiling stands on ADR-0014's input-cost argument. Assert the hasher
    // actually accepts what the boundary lets through — bcrypt, rejected in
    // that ADR, would have silently truncated at 72 bytes.
    const service = new PasswordService(CURRENT);
    const longest = 'a'.repeat(256);
    expect(await service.verify(await service.hash(longest), longest)).toEqual({
      valid: true,
      needsRehash: false,
    });
  });
});

describe('PasswordService.verify', () => {
  it('rejects the wrong password without reporting a rehash', async () => {
    const service = new PasswordService(CURRENT);
    const stored = await service.hash(PASSWORD);
    expect(await service.verify(stored, 'a different password')).toEqual({
      valid: false,
      needsRehash: false,
    });
  });

  it('rejects a malformed stored hash instead of throwing', async () => {
    const service = new PasswordService(CURRENT);
    expect(await service.verify('not a phc string', PASSWORD)).toEqual({
      valid: false,
      needsRehash: false,
    });
  });

  it('returns not-valid for an absent credential', async () => {
    // The timing half of this — that it still performs a full verification —
    // is proved in password.timing.spec.ts.
    const service = new PasswordService(CURRENT);
    expect(await service.verify(null, PASSWORD)).toEqual({ valid: false, needsRehash: false });
  });
});

describe('parseArgon2Phc', () => {
  it('reads the three cost parameters', () => {
    expect(parseArgon2Phc('$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$ZGlnZXN0')).toEqual({
      memoryCostKib: 65_536,
      timeCost: 3,
      parallelism: 4,
    });
  });

  it.each([
    ['a non-argon2id algorithm', '$argon2i$v=19$m=65536,t=3,p=4$c2FsdA$ZGlnZXN0'],
    ['an older version tag', '$argon2id$v=16$m=65536,t=3,p=4$c2FsdA$ZGlnZXN0'],
    ['a missing parameter', '$argon2id$v=19$m=65536,t=3$c2FsdA$ZGlnZXN0'],
    ['a non-numeric parameter', '$argon2id$v=19$m=lots,t=3,p=4$c2FsdA$ZGlnZXN0'],
    ['a truncated string', '$argon2id$v=19$m=65536,t=3,p=4'],
    ['a bcrypt hash', '$2b$12$abcdefghijklmnopqrstuv'],
    ['empty input', ''],
  ])('returns null for %s', (_name, phc) => {
    expect(parseArgon2Phc(phc)).toBeNull();
  });
});
