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
    // `b` used `&code=` for the invitation link until Task 4's review showed
    // `code` had to leave the pattern — it blanks whole URLs on this
    // repository's own SCREAMING_SNAKE error codes. The parameter is `token`
    // here instead, and that is a CONSTRAINT ON THE LINK FORMAT, not a cosmetic
    // edit to a fixture: Tasks 5 and 15 build the verification, reset and
    // invitation URLs, and a link that carries its secret under a parameter
    // name outside this pattern is a link that reaches the logs intact.
    const out = redact({
      a: 'https://app.sentinel.test/cb#access_token=JFqAQ3-_L-BSZrsbVpMUdX2rKzyH',
      b: 'https://app.sentinel.test/accept?org=org_01J&token=JFqAQ3-_L-BSZrsbVpMUdX2rKzyH',
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

  it('leaves the three parameter names that look like credentials and are not', () => {
    // Task 4 review, M2. The first round's pattern listed `key`, `code` and
    // `signature`, and the false-positive control above tested none of them
    // with a realistic value — it proved the 8-character floor and the
    // `tokenize` prefix boundary, which is a weaker property than it looked.
    //
    // These three matter because `redact()` replaces the WHOLE field on a
    // match, so a hit here does not blank a parameter, it blanks the URL. An
    // object-storage key is the shape of this product's entire evidence
    // subsystem, and every error code it defines is SCREAMING_SNAKE over eight
    // characters.
    const input = {
      objectUrl: 'https://minio.test/evidence?key=org/org_01J/report.pdf',
      callback: 'https://app.sentinel.test/callback?code=VALIDATION_ERROR',
      presigned: 'https://s3.test/b/o?X-Amz-Signature=deadbeefdeadbeef&X-Amz-Expires=900',
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
