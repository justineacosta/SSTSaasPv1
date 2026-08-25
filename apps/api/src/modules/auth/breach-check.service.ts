import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from '@sentinel/observability';
import { LOGGER } from '../../infrastructure/tokens.js';
import { BREACH_CHECK_OPTIONS, HIBP_RANGE_TRANSPORT } from './auth.tokens.js';

export interface BreachCheckOptions {
  readonly enabled: boolean;
  /** Base URL of the range endpoint, without the prefix path segment. */
  readonly rangeUrl: string;
  readonly timeoutMs: number;
}

export interface RangeResponse {
  readonly status: number;
  readonly body: string;
}

export interface RangeRequestInit {
  readonly headers: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
}

/**
 * The whole outbound surface of this service: one function, shaped like
 * `fetch`, injected so that no spec in this repository ever touches the
 * network. Deliberately not an interface with methods and not a class — there
 * is exactly one call to make.
 */
export type HibpRangeTransport = (url: string, init: RangeRequestInit) => Promise<RangeResponse>;

/**
 * The default transport: `fetch`, honouring the abort signal so a slow range
 * lookup releases its socket rather than merely being ignored.
 *
 * **`redirect: 'error'`.** A followed redirect goes wherever the responding
 * server points, including loopback, link-local and cloud metadata ranges, and
 * no SSRF guard exists in this repository yet — critical security rule 9's
 * guard is Phase 4's and is written about scanner traffic. Nothing beyond the
 * five-character prefix could leak either way (the URL is rebuilt by the
 * redirect target, not carried), so ADR-0015's privacy claim never depended on
 * this; the foreclosure costs one property and is worth taking in a security
 * product. A redirect now rejects, which the caller treats as `transport-error`
 * and fails open on, exactly like any other transport failure.
 */
export const fetchRangeTransport: HibpRangeTransport = async (url, init) => {
  const response = await fetch(url, {
    headers: { ...init.headers },
    signal: init.signal,
    redirect: 'error',
  });
  return { status: response.status, body: await response.text() };
};

/** Why a lookup failed. Safe to log: none of these values derive from the password. */
type FailureReason = 'timeout' | 'unexpected-status' | 'unparseable-body' | 'transport-error';

/**
 * One line of a range response: a 35-character hex suffix, a colon, and a
 * decimal occurrence count. Anchored, because a body that is an HTML error page
 * must parse as zero lines rather than as a lenient partial match.
 */
const RANGE_LINE = /^([0-9A-Fa-f]{35}):(\d+)$/;

/**
 * `true`/`false` for a decided lookup, `null` when the body did not parse as a
 * range response at all.
 *
 * A padded entry is discarded on its zero count. HIBP's API documentation
 * (haveibeenpwned.com/API/v3, Pwned Passwords section, read 2026-08-25) states
 * that `Add-Padding` "pads out responses to ensure all results contain a random
 * number of records between 800 and 1,000" and that "padded entries always have
 * a password count of 0 and can be discarded once received". Without this
 * filter a padded row could report a breach for a password that never appeared
 * in one.
 */
export function matchRangeBody(body: string, suffix: string): boolean | null {
  const target = suffix.toUpperCase();
  let parsedLines = 0;
  let matched = false;

  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;
    const fields = RANGE_LINE.exec(line);
    if (fields === null) continue;
    parsedLines += 1;
    const lineSuffix = fields[1]?.toUpperCase();
    const count = Number(fields[2]);
    if (lineSuffix === target && count > 0) matched = true;
  }

  if (parsedLines === 0) return null;
  return matched;
}

class RangeTimeoutError extends Error {
  constructor() {
    super('The breach-check range lookup timed out.');
    this.name = 'RangeTimeoutError';
  }
}

/**
 * The HIBP k-anonymity breach check, per ADR-0015.
 *
 * The password is hashed with SHA-1 locally; only the first five hex characters
 * of the digest leave the process; the remaining 35 are matched here. The
 * password never leaves the process and neither does its full hash.
 *
 * **SHA-1 appears in this file and it is not being used as a security
 * primitive.** It is the range API's addressing scheme for a bucket lookup.
 * Nothing is stored under it, nothing is authenticated by it, and its collision
 * weakness is irrelevant to a lookup whose answer is verified locally against
 * the full 40-character digest. ADR-0015 records this so a scanner hit here has
 * an answer waiting for it.
 *
 * **It fails open.** On any error, timeout, non-200, or unparseable body the
 * password is allowed and a `warn` is logged. ADR-0015 states the trade and
 * names the rejected alternative: fail-closed hands a third party a switch that
 * turns off registration, password change and password reset.
 */
@Injectable()
export class BreachCheckService {
  constructor(
    @Inject(BREACH_CHECK_OPTIONS) private readonly options: BreachCheckOptions,
    @Inject(HIBP_RANGE_TRANSPORT) private readonly transport: HibpRangeTransport,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /** True only for a confirmed match. Every other outcome, including failure, is false. */
  async isBreached(password: string): Promise<boolean> {
    if (!this.options.enabled) return false;

    const digest = createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
    const url = `${this.options.rangeUrl.replace(/\/+$/, '')}/${digest.slice(0, 5)}`;
    const startedAt = process.hrtime.bigint();

    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    // Classifying the failure by which promise won the race does not work, and
    // the difference is not cosmetic. Aborting the controller makes the
    // transport's own promise reject too — `fetch` rejects with an `AbortError`
    // — and that rejection can settle the race first, filing a timeout under
    // `transport-error`. The flag records what actually happened, independently
    // of ordering.
    let timedOut = false;
    try {
      // Both an abort signal and a race. The signal is what actually releases
      // the socket; the race is what makes the 2s bound hold even for a
      // transport that ignores the signal, which a stub or a future adapter
      // easily might.
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(new RangeTimeoutError());
        }, this.options.timeoutMs);
      });
      const response = await Promise.race([
        this.transport(url, {
          headers: {
            // Documented at haveibeenpwned.com/API/v3 (read 2026-08-25) as
            // padding every response to between 800 and 1,000 records, so the
            // size of a response reveals nothing about the bucket.
            'Add-Padding': 'true',
            Accept: 'text/plain',
          },
          signal: controller.signal,
        }),
        timeout,
      ]);

      if (response.status !== 200) {
        this.failOpen('unexpected-status', startedAt, { status: response.status });
        return false;
      }

      const outcome = matchRangeBody(response.body, digest.slice(5));
      if (outcome === null) {
        this.failOpen('unparseable-body', startedAt);
        return false;
      }
      return outcome;
    } catch (error) {
      const reason: FailureReason =
        timedOut || error instanceof RangeTimeoutError ? 'timeout' : 'transport-error';
      this.failOpen(reason, startedAt);
      return false;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * The log line, and what is deliberately absent from it.
   *
   * No password. No SHA-1. **No five-character prefix, and no URL** — the URL
   * ends in the prefix, and the prefix narrows the candidate space while buying
   * nothing diagnostically. Critical security rule 6 has no exceptions, and a
   * log aggregator keeps what it is handed indefinitely.
   *
   * The caught error object is not attached either: a transport error message
   * can quote the request URL. The reason tag and the elapsed time are what an
   * operator actually needs, and ADR-0015 names the rate of these events as
   * owed alerting work for Phase 4 — a check that has been failing open for a
   * month is functionally a check that was removed.
   */
  private failOpen(
    reason: FailureReason,
    startedAt: bigint,
    extra: Record<string, number | string> = {},
  ): void {
    this.logger.warn(
      {
        reason,
        elapsedMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
        ...extra,
      },
      'Password breach check failed open; the password was allowed.',
    );
  }
}
