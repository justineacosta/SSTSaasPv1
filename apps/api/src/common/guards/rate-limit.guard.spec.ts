import { describe, expect, it } from 'vitest';
import { normaliseIp } from './rate-limit.guard.js';

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
