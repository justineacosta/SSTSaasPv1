import { describe, expect, it } from 'vitest';
import { normaliseAccountIdentifier, normaliseIp, resolveIdentifier } from './rate-limit.guard.js';
import { RATE_LIMIT_CLASSES } from './rate-limit.config.js';

describe('normaliseIp', () => {
  it('treats an IPv4-mapped IPv6 address as the IPv4 address it is', () => {
    // Two spellings of one client must be one bucket. They start arriving
    // together the moment `trust proxy` is enabled and forwarded addresses show
    // up in plain v4 form alongside directly-connected mapped-v6 ones.
    expect(normaliseIp('::ffff:127.0.0.1')).toBe('127.0.0.1');
    expect(normaliseIp('::ffff:127.0.0.1')).toBe(normaliseIp('127.0.0.1'));
    expect(normaliseIp('::FFFF:10.0.0.7')).toBe('10.0.0.7');
  });

  it('leaves a genuine IPv6 address alone, lowercased', () => {
    expect(normaliseIp('2001:DB8::1')).toBe('2001:db8::1');
    expect(normaliseIp('::1')).toBe('::1');
  });

  it('does not mistake an address that merely contains the mapped prefix', () => {
    expect(normaliseIp('2001:db8::ffff:1.2.3.4')).toBe('2001:db8::ffff:1.2.3.4');
  });
});

describe('resolveIdentifier', () => {
  const login = RATE_LIMIT_CLASSES.login;

  it('normalises the IP it returns, not merely the helper in isolation', () => {
    // `normaliseIp` had a unit test and no caller test, so deleting the call
    // site left the suite green. This asserts the wiring.
    expect(resolveIdentifier('perIp', { ip: '::ffff:10.0.0.7' }, login)).toBe('10.0.0.7');
  });

  it('falls back to the socket address when Express has no view of the IP', () => {
    expect(resolveIdentifier('perIp', { socket: { remoteAddress: '10.0.0.9' } }, login)).toBe(
      '10.0.0.9',
    );
  });

  it('reads the account from the body for a body-keyed class, hashed', () => {
    const resolved = resolveIdentifier('perPrincipal', { body: { email: 'a@example.com' } }, login);
    expect(resolved).toBeDefined();
    expect(resolved).not.toContain('a@example.com');
    expect(resolved).not.toContain('@');
  });

  it('gives the same bucket for the same account written differently', () => {
    const shapes = ['a@example.com', 'A@Example.COM', '  a@example.com  '];
    const resolved = shapes.map((email) =>
      resolveIdentifier('perPrincipal', { body: { email } }, login),
    );
    expect(new Set(resolved).size).toBe(1);
  });

  it('gives different buckets for different accounts', () => {
    const a = resolveIdentifier('perPrincipal', { body: { email: 'a@example.com' } }, login);
    const b = resolveIdentifier('perPrincipal', { body: { email: 'b@example.com' } }, login);
    expect(a).not.toBe(b);
  });

  it('resolves nothing rather than sharing one bucket for every malformed body', () => {
    // A shared "undefined" bucket would be worse than no limit: every caller
    // with a malformed body would exhaust one window and lock out the rest.
    const login_ = login;
    for (const body of [
      undefined,
      null,
      'text',
      [],
      { email: 42 },
      { email: null },
      { email: [] },
      { email: '   ' },
      {},
    ]) {
      expect(
        resolveIdentifier('perPrincipal', { body }, login_),
        JSON.stringify(body),
      ).toBeUndefined();
    }
  });

  it('reads the authenticated principal for an authenticated class', () => {
    expect(
      resolveIdentifier(
        'perPrincipal',
        { principalId: 'usr_1', body: { email: 'attacker@example.com' } },
        RATE_LIMIT_CLASSES.generalSession,
      ),
    ).toBe('usr_1');
  });
});

describe('normaliseAccountIdentifier', () => {
  it('folds the same address written in NFC and NFD into one bucket', () => {
    const nfc = 'caf\u00e9@example.com';
    const nfd = 'cafe\u0301@example.com';
    expect(nfc).not.toBe(nfd);
    expect(normaliseAccountIdentifier(nfc)).toBe(normaliseAccountIdentifier(nfd));
  });

  it('is stable, so a restart does not hand everyone a fresh window', () => {
    expect(normaliseAccountIdentifier('A@Example.com')).toBe('a@example.com');
  });
});

describe('the account bucket digest', () => {
  it('is pinned: same input, same bucket, in every process and every instance', () => {
    // A per-process or per-instance salt would split one account's window
    // across instances and multiply the effective limit by the instance count —
    // a security defect dressed as hardening, and invisible to a test that only
    // checks stability within one process. Pinning the digest catches it, and
    // catches a truncation that would make collisions likely at the same time.
    const bucket = resolveIdentifier(
      'perPrincipal',
      { body: { email: 'pinned@example.com' } },
      RATE_LIMIT_CLASSES.login,
    );
    expect(bucket).toBe('drEi8prkvL9JOKpp7hx2HW');
  });

  it('keeps enough width that unrelated accounts do not share a window', () => {
    // Two accounts colliding means one is limited by the other's traffic — a
    // lockout the victim cannot see or avoid.
    const bucket = resolveIdentifier(
      'perPrincipal',
      { body: { email: 'width@example.com' } },
      RATE_LIMIT_CLASSES.login,
    );
    expect(bucket?.length).toBeGreaterThanOrEqual(22);
  });
});
