import { describe, expect, it } from 'vitest';
import { type Argon2Parameters, PasswordService } from './password.service.js';

/**
 * `security/authentication.md` §2: "Login timing equalised whether or not the
 * account exists." This file is the proof, and it is the reason
 * `PasswordService.verify` takes a nullable stored hash at all.
 *
 * **Reduced parameters, deliberately.** At the configured production starting
 * point (m=64MiB, t=3, p=4, ~250ms per verification) the sample count below
 * would cost minutes. The property under test — that both branches perform one
 * full Argon2id verification — is parameter-independent: it is a statement
 * about which code path runs, not about how expensive the path is. Reducing the
 * cost is therefore a reduction in runtime, not in coverage. Being able to do
 * this at all is the first real payoff of ADR-0014's decision to hold the
 * parameters in configuration rather than in a constant.
 */
const REDUCED: Argon2Parameters = { memoryCostKib: 16_384, timeCost: 2, parallelism: 1 };

/** Ruling 5's floor is 15. */
const SAMPLES = 21;

/**
 * Maximum permitted relative difference between the two medians.
 *
 * SET FROM MEASUREMENT, not from taste. Five consecutive runs on the
 * development machine (Windows x64, Node v26.7.0) at the parameters above,
 * with the tolerance forced to 0.00001 so every run reported its numbers:
 * relative differences of 0.0122, 0.0263, 0.0252, 0.0486 and 0.0308, on
 * medians between 7.4ms and 10.1ms. Worst observed spread: 4.9%.
 *
 * 0.25 is roughly five times that, and the headroom is deliberate. This
 * assertion is not trying to resolve a few percent of scheduler jitter on a
 * shared CI runner; it is trying to catch the one regression that matters,
 * which is someone short-circuiting the absent-account branch into an early
 * return. In the same five runs that branch, when actually short-circuited,
 * measured 0.003–0.006ms against ~7.8ms — a relative difference near 2000,
 * four orders of magnitude outside this tolerance. The negative control at the
 * end of the test measures exactly that and asserts it lands *outside* 0.25,
 * so the number below cannot quietly become one that discriminates nothing.
 *
 * A tighter tolerance would buy no additional detection and would buy a flaky
 * security test, and a flaky security test gets deleted.
 */
const TOLERANCE = 0.25;

/** Warm-up passes discarded before sampling: napi binding load, JIT, allocator. */
const WARMUP = 5;

const PASSWORD = 'correct horse battery staple';
const WRONG_PASSWORD = 'not the stored password at all';

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? Number.NaN;
  return ((sorted[middle - 1] ?? Number.NaN) + (sorted[middle] ?? Number.NaN)) / 2;
}

async function elapsedMs(run: () => Promise<unknown>): Promise<number> {
  const startedAt = process.hrtime.bigint();
  await run();
  return Number(process.hrtime.bigint() - startedAt) / 1e6;
}

function relativeDifference(a: number, b: number): number {
  return Math.abs(a - b) / Math.min(a, b);
}

describe('PasswordService.verify timing equality', () => {
  it('spends the same time on an absent account as on an existing one', async () => {
    const service = new PasswordService(REDUCED);
    const storedHash = await service.hash(PASSWORD);

    for (let i = 0; i < WARMUP; i++) {
      await service.verify(storedHash, WRONG_PASSWORD);
      await service.verify(null, WRONG_PASSWORD);
    }

    const existing: number[] = [];
    const absent: number[] = [];
    const shortCircuit: number[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      // Interleaved rather than run as two blocks: a machine that gets busier
      // partway through the run then penalises both paths equally instead of
      // manufacturing a difference between them.
      existing.push(await elapsedMs(() => service.verify(storedHash, WRONG_PASSWORD)));
      absent.push(await elapsedMs(() => service.verify(null, WRONG_PASSWORD)));
      // The negative control: what the absent-account branch would cost if
      // someone "optimised" it into an early return.
      shortCircuit.push(await elapsedMs(() => Promise.resolve({ valid: false })));
    }

    const existingMedian = median(existing);
    const absentMedian = median(absent);
    const shortCircuitMedian = median(shortCircuit);

    const observed = relativeDifference(existingMedian, absentMedian);
    expect(
      observed,
      `existing=${existingMedian.toFixed(3)}ms absent=${absentMedian.toFixed(3)}ms ` +
        `shortCircuit=${shortCircuitMedian.toFixed(3)}ms relative=${observed.toFixed(4)}`,
    ).toBeLessThan(TOLERANCE);

    // Without this, the assertion above would still pass if BOTH paths became
    // free — a tolerance on a ratio says nothing about the magnitude. This is
    // what gives the test teeth: an early return is at least an order of
    // magnitude outside the tolerance the real path sits inside.
    const controlDifference = relativeDifference(existingMedian, shortCircuitMedian);
    expect(
      controlDifference,
      `an early return measures ${shortCircuitMedian.toFixed(3)}ms against ` +
        `${existingMedian.toFixed(3)}ms; if this is inside the tolerance the ` +
        `assertion above is not discriminating anything`,
    ).toBeGreaterThan(TOLERANCE);
  });
});
