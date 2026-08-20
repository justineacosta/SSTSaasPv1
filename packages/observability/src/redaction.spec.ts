import { describe, expect, it } from 'vitest';
import { REDACTED, redact } from './redaction.js';

describe('redact', () => {
  it('redacts by key name at the top level', () => {
    expect(redact({ password: 'hunter2', email: 'a@b.c' })).toEqual({
      password: REDACTED,
      email: 'a@b.c',
    });
  });

  it('redacts by key name at any depth', () => {
    expect(redact({ user: { credential: { passwordHash: 'x' }, name: 'Marcus' } })).toEqual({
      user: { credential: { passwordHash: REDACTED }, name: 'Marcus' },
    });
  });

  it('matches key names case-insensitively and as substrings', () => {
    const out = redact({ Authorization: 'Bearer x', apiKey: 'k', X_CSRF_TOKEN: 't' }) as Record<
      string,
      unknown
    >;
    expect(out.Authorization).toBe(REDACTED);
    expect(out.apiKey).toBe(REDACTED);
    expect(out.X_CSRF_TOKEN).toBe(REDACTED);
  });

  it('redacts inside arrays', () => {
    expect(redact([{ token: 'a' }, { token: 'b' }])).toEqual([
      { token: REDACTED },
      { token: REDACTED },
    ]);
  });

  it('applies the value-shape backstop to a bearer token under an innocent key', () => {
    const out = redact({ note: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def' }) as Record<
      string,
      unknown
    >;
    expect(out.note).toBe(REDACTED);
  });

  it('applies the value-shape backstop to a postgres URL containing a password', () => {
    const out = redact({ dsn: 'postgresql://user:hunter2@host:5432/db' }) as Record<
      string,
      unknown
    >;
    expect(out.dsn).toBe(REDACTED);
  });

  it('leaves ordinary values alone', () => {
    const input = { scanId: 'scn_01J', count: 42, ok: true, at: null };
    expect(redact(input)).toEqual(input);
  });

  it('does not loop forever on a circular reference', () => {
    const circular: Record<string, unknown> = { name: 'x' };
    circular.self = circular;
    expect(() => redact(circular)).not.toThrow();
  });

  it('preserves Error name and message but drops the stack', () => {
    const out = redact(new Error('boom')) as Record<string, unknown>;
    expect(out.message).toBe('boom');
    expect(out.stack).toBeUndefined();
  });
});
