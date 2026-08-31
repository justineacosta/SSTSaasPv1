/**
 * `security/authentication.md` §7'S PER-ACCOUNT BRUTE-FORCE LADDER, AS TWO PURE
 * FUNCTIONS.
 *
 * §7 reads: "Progressive delay then temporary lock per account; independent
 * per-IP limits so one attacker cannot lock out a whole tenant." Everything
 * below is that sentence with the two columns `schema.prisma` already provides
 * — `User.failedLoginCount` and `User.lockedUntil` — and nothing else.
 *
 * # The escalating window IS the progressive delay
 *
 * A login handler that sleeps is a handler an attacker can pin: N concurrent
 * attempts hold N connections and N event-loop timers for as long as the
 * attacker chooses, on a single-threaded runtime, and the cost lands on us
 * rather than on them. Growing the *lock* instead costs the attacker time and
 * costs us one integer and one timestamp. There is no `setTimeout` anywhere in
 * this module, and there must not be one.
 *
 * # The figures
 *
 * §7 names none of them, so they are decisions taken here and recorded in that
 * document in the same change — the relationship `rate-limit.config.ts` has
 * with `abuse-prevention.md` §1, and the shape Task 8 used when it wrote
 * 30/hour into §1 rather than pretending it had transcribed it.
 *
 * | Consecutive failures after the attempt | `lockedUntil` |
 * |---|---|
 * | 1-4 | not set |
 * | 5 | now + 1 minute |
 * | 6 | now + 5 minutes |
 * | 7 | now + 15 minutes |
 * | 8 or more | now + 30 minutes |
 *
 * Five is where it starts because four is a plausible number of genuine typos
 * for somebody with two passwords in their head, and a one-minute lock costs
 * such a person a minute while costing a guesser their entire throughput: from
 * that point on the account admits at most one attempt per minute, then per
 * five, then per fifteen, then per thirty.
 *
 * # Thirty minutes is a CAP, and the cap is the security property
 *
 * Not a ceiling for tidiness. Without one the ladder becomes an indefinite lock
 * that an *unauthenticated* caller can impose on any account whose address they
 * can guess — which is §7's own "one attacker must not lock out a whole tenant"
 * reappearing one level down, with the tenant replaced by a person. Thirty
 * minutes is long enough that online guessing is worthless and short enough
 * that a locked-out user does not need a support ticket.
 *
 * # What this deliberately does NOT do
 *
 * It has no opinion about attempts that arrive while a lock is live. That rule
 * — **an attempt during a live lock changes no state at all** — belongs to
 * `LoginService`, because it is about whether to write, not about what to
 * write. Its reason is the same as the cap's: an attacker who wants an account
 * offline must not be able to keep it there forever by attempting once a
 * minute. The counter is still not reset by a lock expiring, only by a
 * successful login, so the ladder goes on climbing across cycles.
 */

/** The failure count at which the first lock is applied. */
export const LOCKOUT_THRESHOLD = 5;

/**
 * The window, in seconds, for the 5th, 6th, 7th and 8th-or-later failure.
 *
 * Exported so `login.service.spec.ts` and the integration lane can assert
 * against the same numbers this function uses, rather than against a second
 * copy that can drift. The last entry is the cap.
 */
export const LOCKOUT_LADDER_SECONDS = [60, 300, 900, 1_800] as const;

const MILLISECONDS = 1_000;

/**
 * The instant an account is locked until, given the consecutive-failure count
 * **after** the attempt that just failed, or `null` when it is not locked.
 *
 * Takes `now` rather than reading the clock: carry-forward ruling 49. A caller
 * that already read the clock for the audit row must stamp the lock with the
 * same reading, because two readings of one operation are two facts that can
 * disagree, and this row is read during an incident.
 *
 * A count of zero or below returns `null` rather than throwing.
 * `failedLoginCount` is a plain `Int` with no check constraint below it, and an
 * arithmetic surprise must not turn a login into a 500 — the value it fails to
 * is "no lock", which the caller handles already.
 */
export function lockedUntilFor(consecutiveFailures: number, now: Date): Date | null {
  if (consecutiveFailures < LOCKOUT_THRESHOLD) return null;

  const rung = Math.min(consecutiveFailures - LOCKOUT_THRESHOLD, LOCKOUT_LADDER_SECONDS.length - 1);
  // `?? ` is unreachable — `rung` is clamped into range above — and is here
  // because `noUncheckedIndexedAccess` is on and a non-null assertion would be
  // a claim rather than a value. The fallback is the cap, which is the
  // fail-safe direction if the clamp ever stopped holding.
  const seconds = LOCKOUT_LADDER_SECONDS[rung] ?? LOCKOUT_LADDER_SECONDS.at(-1) ?? 0;
  return new Date(now.getTime() + seconds * MILLISECONDS);
}

/**
 * Whether `lockedUntil` is still in force at `now`.
 *
 * Strictly greater than, so the lock stops at the instant it names rather than
 * one tick later. `null` — never locked, or cleared by a successful login — is
 * false.
 */
export function isLocked(lockedUntil: Date | null, now: Date): boolean {
  return lockedUntil !== null && lockedUntil.getTime() > now.getTime();
}
