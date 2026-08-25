import { describe, expect, it } from 'vitest';
import { REDACTED, redact, redactSecretsInText } from './redaction.js';

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

  it('applies the value-shape backstop to a token carried in a URL query parameter', () => {
    // The measured gap (Phase 2 Task 4, Ruling 9): `token` is a denylisted KEY
    // fragment, so `{ token }` was always redacted — but the shape that reaches
    // a real log line is the verification link under an innocent key, and no
    // value pattern matched a bare base64url string. Whole-value redaction
    // here, not span redaction: a structured field holding a credential is a
    // field whose entire contents are suspect.
    const out = redact({
      verifyUrl: 'https://app.sentinel.test/auth/verify?token=JFqAQ3-_L-BSZrsbVpMUdX2rKzyH',
    }) as Record<string, unknown>;
    expect(out.verifyUrl).toBe(REDACTED);
  });

  it('applies it to the fragment form and to a later parameter in the string', () => {
    const out = redact({
      a: 'https://app.sentinel.test/cb#access_token=JFqAQ3-_L-BSZrsbVpMUdX2rKzyH',
      b: 'https://app.sentinel.test/accept?org=org_01J&code=JFqAQ3-_L-BSZrsbVpMUdX2rKzyH',
    }) as Record<string, unknown>;
    expect(out.a).toBe(REDACTED);
    expect(out.b).toBe(REDACTED);
  });

  it('leaves a URL whose parameters are not credentials alone', () => {
    // The false-positive side. Without this the pattern could quietly swallow
    // every URL in the logs, and an operator would lose the routes an incident
    // is traced through. `?code=US` is under the 8-character guard; `tokenize`
    // is not `token=`.
    const input = {
      url: 'https://app.sentinel.test/scans?status=RUNNING&limit=50',
      country: 'https://app.sentinel.test/x?code=US',
      similar: 'https://app.sentinel.test/x?tokenize=please-do-not-redact-me',
    };
    expect(redact(input)).toEqual(input);
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

  it('text-scans the message of an Error nested anywhere in a payload', () => {
    const inner = new Error('leaked here: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def');
    const out = redact({ context: { originalError: inner } }) as {
      context: { originalError: { message: string } };
    };
    expect(out.context.originalError.message).toBe(`leaked here: ${REDACTED}`);
  });

  it('replaces a property whose getter throws instead of crashing', () => {
    const hostile = {
      get poison(): string {
        throw new Error('getter exploded');
      },
      ok: 'value',
    };
    expect(() => redact(hostile)).not.toThrow();
    const out = redact(hostile) as Record<string, unknown>;
    expect(out.poison).toBe('[unreadable]');
    expect(out.ok).toBe('value');
  });
});

describe('redactSecretsInText', () => {
  it('redacts only the matched span, leaving the surrounding text intact', () => {
    const out = redactSecretsInText(
      'exchanging token=Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def now',
    );
    expect(out).toBe(`exchanging token=${REDACTED} now`);
  });

  it('redacts only the token value in a link, keeping the route readable', () => {
    // Span redaction, not whole-message: the docblock on redactSecretsInText
    // promises an operator still gets the rest of the sentence, and the route
    // is the part that makes a log line useful during an incident. This is why
    // the pattern is written as a lookbehind rather than a capture group.
    const out = redactSecretsInText(
      'sending https://app.sentinel.test/auth/reset?token=U32c2rxRXTfuTolNBJYdL332nOS0 to the mailer',
    );
    expect(out).toBe(
      `sending https://app.sentinel.test/auth/reset?token=${REDACTED} to the mailer`,
    );
  });

  it('leaves text with no secret shape byte-identical', () => {
    const text = 'scan scn_01J completed with 3 findings';
    expect(redactSecretsInText(text)).toBe(text);
  });
});
