import { describe, expect, it } from 'vitest';
import { type Argon2Parameters, PasswordService } from './password.service.js';

/**
 * `security/authentication.md` §2: "Login timing equalised whether or not the
 * account exists." This file is the proof, and it is the reason
 * `PasswordService.verify` takes a nullable stored hash at all.
 *
 * **Reduced parameters, because Ruling 5 requires them and CI is not this
 * machine.** `security/authentication.md` §2 documents a tuning *target* of
 * ~250ms per verification at m=64MiB / t=3 / p=4; ADR-0014 says in as many
 * words that the target is untuned, and nothing here has been tuned to it.
 * What the configured defaults actually cost, measured 2026-08-25 on the
 * development machine (Windows 11 x64, Node v26.7.0, 12 logical CPUs, via
 * `node -e` against `@node-rs/argon2` directly): **36.0 ms per verification**
 * (mean of 10) and 37.4 ms for one `hashSync`. The reduced parameters below
 * cost **9.2 ms** on the same run.
 *
 * So the sample count below would cost roughly 1.9 s at the real defaults on
 * *this* hardware — inside Ruling 5's 5-second budget, not "minutes". An
 * earlier version of this comment said minutes, which was wrong by about two
 * orders of magnitude (review 3c5d694, finding F3).
 *
 * The reduction stays anyway, and the orchestrator ruled on it: `ubuntu-latest`
 * is slower and shared, so a 1.9 s local figure is not a CI budget, and the
 * property under test — that both branches perform one full Argon2id
 * verification — is parameter-independent. It is a statement about which code
 * path runs, not about how expensive the path is, so the reduction buys CI
 * headroom rather than costing coverage. **Recorded with its cost: if the
 * reduction ever turns out to hide a parameter-dependent effect, this proof is
 * weaker than it reads.** Being able to reduce at all is the first real payoff
 * of ADR-0014's decision to hold the parameters in configuration.
 */
const REDUCED: Argon2Parameters = { memoryCostKib: 16_384, timeCost: 2, parallelism: 1 };

/** Ruling 5's floor is 15. */
const SAMPLES = 21;

/**
 * Maximum permitted relative difference between the two medians.
 *
 * SET FROM MEASUREMENT, not from taste. **Eleven runs**, all on the development
 * machine (Windows 11 x64, Node v26.7.0, 12 logical CPUs) at the parameters
 * above, with the tolerance forced to 0.00001 so every run reported its
 * numbers. Five by the implementer: 0.0122, 0.0263, 0.0252, 0.0486, 0.0308.
 * Six more by the reviewer (3c5d694, finding F6): 0.0269, 0.0269, **0.0737**,
 * 0.0106, 0.0536, 0.0081. Medians ranged 7.4–10.1 ms.
 *
 * Six more by the re-reviewer: worst **0.0784**. Seventeen runs in total.
 *
 * **Do not quote a headroom multiple off these numbers, and do not tighten the
 * tolerance towards the worst one.** Every batch of samples so far has found a
 * new maximum — 4.86% off the first five, 7.37% off eleven, 7.84% off
 * seventeen — which is what an unbounded jitter distribution does, and is
 * exactly why the two earlier versions of this comment each quoted a headroom
 * ("5×", then "3.4×") that the next batch invalidated. The observed maxima
 * bound nothing; they only show the order of magnitude. 0.25 is set from the
 * *gap* argument below, not from a multiple of the worst sample.
 *
 * The headroom is deliberate. This assertion is not trying to resolve a few
 * percent of scheduler jitter on a shared CI runner; it is trying to catch a
 * short-circuit of the absent-account branch, which measures 0.003–0.007 ms
 * against ~7.8 ms — a relative difference in the thousands, three orders of
 * magnitude outside this tolerance.
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

    // What this control actually does, stated precisely, because an earlier
    // version of the comment on TOLERANCE overstated it (review 3c5d694,
    // finding F7). It asserts that an early return is measurably distinguishable
    // from a real verification AND that TOLERANCE sits below that gap. The gap
    // is ~1500-4000×, so as a bound on TOLERANCE it is very loose: the reviewer
    // set TOLERANCE = 200 with the implementation intact and this file stayed
    // green.
    //
    // It is not useless. It fails if both paths become free (a ratio alone says
    // nothing about magnitude), and it means a full short-circuit cannot be
    // hidden by widening TOLERANCE — the regression's own signal and this
    // bound are the same quantity, which the reviewer confirmed: TOLERANCE=200
    // plus a short-circuited null branch still fails, at relative=3958.5.
    //
    // What it does NOT catch is a widened tolerance hiding a *partial*
    // degradation. A dummy hash baked at drifted parameters measures
    // relative=23.7 (reviewer's mutation H) and would sail through at 200.
    // Only the value of TOLERANCE itself stands against that.
    const controlDifference = relativeDifference(existingMedian, shortCircuitMedian);
    expect(
      controlDifference,
      `an early return measures ${shortCircuitMedian.toFixed(3)}ms against ` +
        `${existingMedian.toFixed(3)}ms; if this is inside the tolerance the ` +
        `assertion above is not discriminating anything`,
    ).toBeGreaterThan(TOLERANCE);
  });
});
