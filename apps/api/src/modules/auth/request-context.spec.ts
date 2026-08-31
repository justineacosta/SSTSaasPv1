import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import { requestContextOf } from './request-context.js';

/**
 * THE THREE REQUEST-DERIVED FIELDS THAT REACH AN APPEND-ONLY TABLE.
 *
 * L1 and L2, Task 8 review. Both bounds in this file were implemented correctly
 * and asserted by nothing: the reviewer switched the address to the
 * client-controlled `X-Forwarded-For` and removed the 512-character cap, and the
 * whole suite stayed green in both cases.
 *
 * That matters more here than in most files because of where the values go.
 * `registrationAttempt` is reachable by an unauthenticated caller who names
 * somebody else's address, so every byte of this is attacker-chosen, and it
 * lands in `PlatformAuditEvent` — a table with `UPDATE` and `DELETE` revoked
 * from the application role, which means nothing can ever clean up what gets
 * written. An unbounded field on that path is an unbounded write.
 */

/** The narrow slice of Express `Request` this function reads. */
const requestWith = (over: {
  ip?: string | undefined;
  headers?: Record<string, string | string[] | undefined>;
  id?: string;
}): Request =>
  ({
    ip: over.ip,
    headers: over.headers ?? {},
    id: over.id,
  }) as unknown as Request;

describe('requestContextOf', () => {
  it('takes the socket peer address, not a client-chosen forwarding header', () => {
    // L2. `trust proxy` is disabled, so `request.ip` is the peer Express saw and
    // `X-Forwarded-For` is a string the caller typed. An audit row carrying a
    // client-chosen address is worse than one carrying none: it is a lie that
    // looks like evidence, in a table an investigation trusts.
    const context = requestContextOf(
      requestWith({
        ip: '203.0.113.7',
        headers: { 'x-forwarded-for': '198.51.100.1', 'x-real-ip': '198.51.100.2' },
      }),
    );

    expect(context.ip).toBe('203.0.113.7');
  });

  it('bounds the user agent at 512 characters', () => {
    // L1. The header is chosen outright by the caller. Without the cap, an
    // unauthenticated request writes as much as the server will accept into a
    // table that cannot be pruned.
    const context = requestContextOf(requestWith({ headers: { 'user-agent': 'A'.repeat(5_000) } }));

    expect(context.userAgent).toHaveLength(512);
  });

  it('leaves a user agent shorter than the bound exactly as it was', () => {
    // The cap must not be a transformation. A truncating function that also
    // trimmed, lower-cased or escaped would make the audit row disagree with
    // what was actually sent.
    const agent = 'Mozilla/5.0 (X11; Linux x86_64)';
    expect(requestContextOf(requestWith({ headers: { 'user-agent': agent } })).userAgent).toBe(
      agent,
    );
  });

  it('records null rather than dropping the field when a value is absent', () => {
    // `null` is "not recorded"; an absent property is a caller who forgot, and
    // the audit row has to be able to tell those apart.
    const context = requestContextOf(requestWith({}));

    expect(context).toEqual({ ip: null, userAgent: null, requestId: null });
    expect(Object.keys(context).sort()).toEqual(['ip', 'requestId', 'userAgent']);
  });

  it('records null for a repeated user-agent header rather than an array', () => {
    // Node joins most repeated headers into one string, but `user-agent` is
    // typed `string | string[]` and this function narrows on `typeof`. The
    // non-string arm must produce `null`, not `undefined` and not a stringified
    // array — carry-forward ruling 57 is the measurement that repeated-header
    // semantics differ per header and are worth pinning where they are read.
    const context = requestContextOf(requestWith({ headers: { 'user-agent': ['one', 'two'] } }));

    expect(context.userAgent).toBeNull();
  });
});
