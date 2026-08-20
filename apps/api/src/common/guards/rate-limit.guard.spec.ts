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

  it('reduces a genuine IPv6 address to its /64, case-insensitively', () => {
    expect(normaliseIp('2001:DB8::1')).toBe(normaliseIp('2001:db8::1'));
    expect(normaliseIp('2001:DB8::1')).toContain('/64');
  });

  it('does not mistake an address that merely contains the mapped prefix', () => {
    // `::ffff:1.2.3.4` is a mapped IPv4 address; `2001:db8::ffff:1.2.3.4` is
    // not, and must not collapse to the bare v4 bucket.
    expect(normaliseIp('2001:db8::ffff:1.2.3.4')).not.toBe('1.2.3.4');
    expect(normaliseIp('2001:db8::ffff:1.2.3.4')).toContain('/64');
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

describe('normaliseIp — IPv6 is bucketed by /64', () => {
  it('puts every address in one /64 into one bucket', () => {
    // A host is routinely delegated a whole /64 — 1.8e19 addresses. Bucketing
    // per address would make every per-IP figure in the table free to bypass
    // for anyone with a v6 allocation, which is the bound the resend class now
    // depends on.
    const a = normaliseIp('2001:db8:abcd:1234::1');
    const b = normaliseIp('2001:db8:abcd:1234::2');
    const c = normaliseIp('2001:db8:abcd:1234:dead:beef:1:2');
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  it('keeps different /64s apart', () => {
    expect(normaliseIp('2001:db8:abcd:1234::1')).not.toBe(normaliseIp('2001:db8:abcd:1235::1'));
    expect(normaliseIp('2001:db8:abcd:1234::1')).not.toBe(normaliseIp('2001:db9:abcd:1234::1'));
  });

  it('expands :: correctly rather than truncating the wrong hextets', () => {
    // `2001:db8::1` is 2001:0db8:0000:0000:...:0001, so its /64 must be
    // 2001:db8:0:0 — not 2001:db8:1 read off the literal text.
    expect(normaliseIp('2001:db8::1')).toBe(normaliseIp('2001:db8:0:0:ffff::9'));
    expect(normaliseIp('2001:db8::1')).not.toBe(normaliseIp('2001:db8:1::1'));
  });

  it('still treats loopback and mapped IPv4 the way the rest of the suite expects', () => {
    expect(normaliseIp('::ffff:127.0.0.1')).toBe('127.0.0.1');
    expect(normaliseIp('127.0.0.1')).toBe('127.0.0.1');
    expect(normaliseIp('::1')).toBe(normaliseIp('::1'));
  });

  it('ignores a zone index, which is local to the host and not part of identity', () => {
    expect(normaliseIp('fe80::1%eth0')).toBe(normaliseIp('fe80::1%eth1'));
  });
});

describe('normaliseAccountIdentifier — the form is pinned, not just its presence', () => {
  it('applies NFKC, not merely NFC', () => {
    // The docblock says this must stay identical to the Phase 2 account lookup.
    // Which normalisation form it *is* was the one thing no test pinned, so
    // switching NFKC to NFC changed behaviour silently. Fullwidth and ligature
    // forms fold under NFKC and survive under NFC.
    expect(normaliseAccountIdentifier('\uff41@example.com')).toBe('a@example.com');
    expect(normaliseAccountIdentifier('\ufb01n@example.com')).toBe('fin@example.com');
  });

  it('does not merge characters that are genuinely distinct letters', () => {
    // NFKC is aggressive; this is the boundary worth pinning, because an
    // over-merge lets one account consume another's window.
    expect(normaliseAccountIdentifier('\u0131@example.com')).not.toBe('i@example.com');
    expect(normaliseAccountIdentifier('a\u200bb@example.com')).not.toBe('ab@example.com');
  });
});
