import { describe, expect, it } from 'vitest';
import {
  CSP_REPORT_MAX_BYTES,
  parseCspReport,
  readBoundedBody,
  sanitizeReportedUrl,
} from './csp-report.js';

describe('parseCspReport', () => {
  const valid = (extra: Record<string, unknown> = {}): string =>
    JSON.stringify({
      'csp-report': {
        'document-uri': 'https://app.example.com/dashboard',
        'violated-directive': 'script-src',
        'blocked-uri': 'inline',
        ...extra,
      },
    });

  it('accepts a report a browser would actually send', () => {
    const result = parseCspReport(valid());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report['violated-directive']).toBe('script-src');
    expect(result.report['blocked-uri']).toBe('inline');
  });

  it('strips a key the schema does not know, rather than passing it through', () => {
    // The guarantee the route's docblock leans on: a field a future browser
    // adds cannot put unreviewed content into the log.
    const result = parseCspReport(valid({ 'injected-key': 'attacker-controlled' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.report)).not.toContain('injected-key');
    expect(JSON.stringify(result.report)).not.toContain('attacker-controlled');
  });

  it('rejects malformed JSON without throwing', () => {
    expect(parseCspReport('{not json')).toEqual({ ok: false, reason: 'malformed-json' });
  });

  it.each([
    ['an empty object', '{}'],
    ['a JSON array', '[]'],
    ['a bare string', '"hello"'],
    ['null', 'null'],
    ['the wrong envelope key', '{"report":{}}'],
    ['a non-object report body', '{"csp-report":"nope"}'],
  ])('rejects %s on schema grounds', (_label, body) => {
    expect(parseCspReport(body)).toEqual({ ok: false, reason: 'schema' });
  });

  it('rejects a field that exceeds its cap instead of truncating it', () => {
    const result = parseCspReport(valid({ 'script-sample': 'x'.repeat(257) }));
    expect(result).toEqual({ ok: false, reason: 'schema' });
  });

  it('masks the document-uri before it can reach the log', () => {
    const result = parseCspReport(
      valid({ 'document-uri': 'https://app.example.com/invitations/9f8b7c6d5e4f3a2b1c0d9e8f' }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report['document-uri']).toBe('https://app.example.com/invitations/:seg');
  });

  it('masks the referrer too, and leaves an empty referrer alone', () => {
    const masked = parseCspReport(
      valid({ referrer: 'https://app.example.com/reset-password?token=live-secret' }),
    );
    expect(masked.ok).toBe(true);
    if (!masked.ok) return;
    expect(masked.report.referrer).toBe('https://app.example.com/reset-password');

    const empty = parseCspReport(valid({ referrer: '' }));
    expect(empty.ok).toBe(true);
    if (!empty.ok) return;
    expect(empty.report.referrer).toBe('');
  });
});

describe('sanitizeReportedUrl', () => {
  it('drops the query string, where a reset or verification token rides', () => {
    // page-map.md commits /reset-password and /verify-email, which
    // conventionally carry their token in the query.
    expect(sanitizeReportedUrl('https://app.example.com/verify-email?token=live-secret')).toBe(
      'https://app.example.com/verify-email',
    );
  });

  it('drops the fragment', () => {
    expect(sanitizeReportedUrl('https://app.example.com/dashboard#anchor')).toBe(
      'https://app.example.com/dashboard',
    );
  });

  it.each([
    ['a UUID', '123e4567-e89b-12d3-a456-426614174000'],
    ["this repo's prefixed UUIDv7", 'finding_01h9zqk4m8n2p5r7t9v1x3y5z7'],
    ['a base64url-ish token', 'Ab3xY7pQ9wZ2mK5nR8tV1sD4'],
    ['a long hex string', '9f8b7c6d5e4f3a2b1c0d9e8f'],
  ])('masks %s in the path', (_label, segment) => {
    expect(sanitizeReportedUrl(`https://app.example.com/invitations/${segment}`)).toBe(
      'https://app.example.com/invitations/:seg',
    );
  });

  it.each(['invitations', 'reset-password', 'organizations', 'audit-logs', 'dashboard', 'v1'])(
    'keeps the real route name %s',
    (segment) => {
      expect(sanitizeReportedUrl(`https://app.example.com/${segment}`)).toBe(
        `https://app.example.com/${segment}`,
      );
    },
  );

  it('keeps the origin so a report is still attributable', () => {
    expect(sanitizeReportedUrl('https://app.example.com:8443/x/9f8b7c6d5e4f3a2b1c0d9e8f')).toBe(
      'https://app.example.com:8443/x/:seg',
    );
  });

  it('does not echo an unparsable value back into the log', () => {
    expect(sanitizeReportedUrl('not a url')).toBe('[unparsable]');
  });

  it('is not fooled by credentials in the authority', () => {
    // `new URL().origin` drops userinfo, so a password embedded in the URL
    // cannot survive into the log.
    const sanitized = sanitizeReportedUrl('https://user:hunter2@app.example.com/dashboard');
    expect(sanitized).toBe('https://app.example.com/dashboard');
    expect(sanitized).not.toContain('hunter2');
  });
});

describe('CSP_REPORT_MAX_BYTES', () => {
  it('leaves headroom over the largest field the schema keeps', () => {
    // original-policy is capped at 4096; a body cap below that would reject
    // reports the schema would otherwise have accepted.
    expect(CSP_REPORT_MAX_BYTES).toBeGreaterThan(4096);
  });
});

describe('readBoundedBody', () => {
  const post = (body: BodyInit, headers: Record<string, string> = {}): Request =>
    new Request('https://app.example.com/api/csp-report', { method: 'POST', body, headers });

  it('reads a normal report', async () => {
    await expect(readBoundedBody(post('{"csp-report":{}}'))).resolves.toBe('{"csp-report":{}}');
  });

  it('refuses a body larger than the cap', async () => {
    const oversized = 'x'.repeat(CSP_REPORT_MAX_BYTES + 1);
    await expect(readBoundedBody(post(oversized))).resolves.toBeNull();
  });

  it('accepts a body exactly at the cap', async () => {
    const exact = 'x'.repeat(CSP_REPORT_MAX_BYTES);
    await expect(readBoundedBody(post(exact))).resolves.toHaveLength(CSP_REPORT_MAX_BYTES);
  });

  it('refuses on an oversized Content-Length without reading the stream', async () => {
    // The fast path: a huge declared length is rejected before a byte is
    // buffered. `bodyUsed` stays false because the stream was never read.
    const request = post('{}', { 'content-length': String(CSP_REPORT_MAX_BYTES + 1) });
    await expect(readBoundedBody(request)).resolves.toBeNull();
    expect(request.bodyUsed).toBe(false);
  });

  it('still refuses an oversized body when Content-Length lies about it', async () => {
    // The header is client-supplied, so it is a fast path and not the control.
    // A stream that under-declares itself must still be cut off.
    const request = post('x'.repeat(CSP_REPORT_MAX_BYTES + 1), { 'content-length': '10' });
    await expect(readBoundedBody(request)).resolves.toBeNull();
  });

  it('refuses a request with no body at all', async () => {
    const request = new Request('https://app.example.com/api/csp-report', { method: 'POST' });
    await expect(readBoundedBody(request)).resolves.toBeNull();
  });
});
