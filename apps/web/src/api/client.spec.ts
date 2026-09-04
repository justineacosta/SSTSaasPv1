import { errorEnvelopeSchema, loginResponseSchema, sessionResponseSchema } from '@sentinel/contracts';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  createApiClient,
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  isSafeMethod,
  readCookie,
} from './client';
import { ApiError } from './errors';

/**
 * The API client is the piece every later task inherits, and the one place a
 * mistake is invisible from the screen: a missing `credentials: 'include'`
 * looks exactly like "the server logged me out", and a CSRF header attached to
 * a GET looks like nothing at all until a preflight budget matters.
 */

const okSchema = z.object({ status: z.literal('OK') });

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function envelope(overrides: Partial<{ code: string; details: Record<string, unknown> }> = {}) {
  return {
    error: {
      code: overrides.code ?? 'VALIDATION_ERROR',
      message: 'The request body failed validation.',
      requestId: 'req_01JABCDEF',
      ...(overrides.details === undefined ? {} : { details: overrides.details }),
    },
  };
}

function clientWith(
  fetchImpl: typeof fetch,
  cookieHeader = `${CSRF_COOKIE_NAME}=csrf-value-123`,
): ReturnType<typeof createApiClient> {
  return createApiClient({
    baseUrl: 'https://api.sentinel.test',
    fetchImpl,
    readCookieHeader: () => cookieHeader,
  });
}

function lastInit(fetchImpl: ReturnType<typeof vi.fn>): RequestInit {
  const call: unknown[] | undefined = fetchImpl.mock.calls.at(-1);
  if (call === undefined) throw new Error('fetch was never called');
  return call[1] as RequestInit;
}

describe('readCookie', () => {
  it('finds a cookie by its exact name, prefix included', () => {
    const header = `theme=dark; ${CSRF_COOKIE_NAME}=abc123; other=1`;
    expect(readCookie(header, CSRF_COOKIE_NAME)).toBe('abc123');
  });

  it('does not match a different cookie whose name merely ends with the target', () => {
    // `csrf` is the name security/authentication.md §4 originally used and the
    // one the Task 16 plan text still says. A sloppy match would read it and
    // echo the wrong value.
    expect(readCookie('csrf=wrong-one', CSRF_COOKIE_NAME)).toBeNull();
  });

  it('keeps a value containing "=" intact', () => {
    expect(readCookie(`${CSRF_COOKIE_NAME}=YWJj==`, CSRF_COOKIE_NAME)).toBe('YWJj==');
  });

  it('returns null when the cookie is absent or the header is empty', () => {
    expect(readCookie('', CSRF_COOKIE_NAME)).toBeNull();
    expect(readCookie('a=1; b=2', CSRF_COOKIE_NAME)).toBeNull();
  });
});

describe('isSafeMethod', () => {
  it('treats exactly the RFC 9110 safe methods as safe', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'TRACE']) {
      expect(isSafeMethod(method)).toBe(true);
    }
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(isSafeMethod(method)).toBe(false);
    }
  });
});

describe('createApiClient — the wire', () => {
  it('sends credentials: include on every request', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse({ status: 'OK' })));
    await clientWith(fetchImpl as unknown as typeof fetch).request({
      method: 'GET',
      path: '/api/v1/thing',
      responseSchema: okSchema,
    });
    expect(lastInit(fetchImpl).credentials).toBe('include');
  });

  it('attaches the CSRF header on an unsafe method', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse({ status: 'OK' })));
    await clientWith(fetchImpl as unknown as typeof fetch).request({
      method: 'POST',
      path: '/api/v1/thing',
      body: { a: 1 },
      responseSchema: okSchema,
    });
    const headers = new Headers(lastInit(fetchImpl).headers);
    expect(headers.get(CSRF_HEADER_NAME)).toBe('csrf-value-123');
  });

  it('does NOT attach the CSRF header on a safe method', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse({ status: 'OK' })));
    await clientWith(fetchImpl as unknown as typeof fetch).request({
      method: 'GET',
      path: '/api/v1/thing',
      responseSchema: okSchema,
    });
    const headers = new Headers(lastInit(fetchImpl).headers);
    expect(headers.get(CSRF_HEADER_NAME)).toBeNull();
  });

  it('attaches the CSRF header on every unsafe method, not only POST', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse({ status: 'OK' })));
      await clientWith(fetchImpl as unknown as typeof fetch).request({
        method,
        path: '/api/v1/thing',
        responseSchema: okSchema,
      });
      const headers = new Headers(lastInit(fetchImpl).headers);
      expect(headers.get(CSRF_HEADER_NAME), `${method} carried no CSRF header`).toBe(
        'csrf-value-123',
      );
    }
  });

  it('omits the CSRF header when the cookie is absent, and lets the server refuse', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse({ status: 'OK' })));
    await clientWith(fetchImpl as unknown as typeof fetch, 'theme=dark').request({
      method: 'POST',
      path: '/api/v1/thing',
      responseSchema: okSchema,
    });
    const headers = new Headers(lastInit(fetchImpl).headers);
    expect(headers.get(CSRF_HEADER_NAME)).toBeNull();
  });

  it('builds the URL from the injected base and trims a trailing slash', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse({ status: 'OK' })));
    const client = createApiClient({
      baseUrl: 'https://api.sentinel.test/',
      fetchImpl: fetchImpl,
      readCookieHeader: () => '',
    });
    await client.request({ method: 'GET', path: '/api/v1/thing', responseSchema: okSchema });
    const call = fetchImpl.mock.calls.at(-1) as unknown[] | undefined;
    expect(call?.[0]).toBe('https://api.sentinel.test/api/v1/thing');
  });

  it('serialises the body as JSON and sets the content type only when there is one', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse({ status: 'OK' })));
    const client = clientWith(fetchImpl);

    await client.request({
      method: 'POST',
      path: '/api/v1/thing',
      body: { email: 'a@b.test' },
      responseSchema: okSchema,
    });
    expect(lastInit(fetchImpl).body).toBe('{"email":"a@b.test"}');
    expect(new Headers(lastInit(fetchImpl).headers).get('Content-Type')).toBe('application/json');

    await client.request({ method: 'GET', path: '/api/v1/thing', responseSchema: okSchema });
    expect(lastInit(fetchImpl).body).toBeUndefined();
    expect(new Headers(lastInit(fetchImpl).headers).get('Content-Type')).toBeNull();
  });
});

describe('createApiClient — responses are parsed, never cast', () => {
  it('returns the parsed body on success', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse({ mfaRequired: false })));
    const result = await clientWith(fetchImpl as unknown as typeof fetch).request({
      method: 'POST',
      path: '/api/v1/auth/login',
      body: {},
      responseSchema: loginResponseSchema,
    });
    expect(result).toEqual({ mfaRequired: false });
  });

  it('rejects a 2xx body the response schema does not accept', async () => {
    // The shape a client would otherwise cast and carry three components deep
    // before it failed as `undefined is not an object`.
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse({ mfaRequired: 'yes please' })));
    const promise = clientWith(fetchImpl as unknown as typeof fetch).request({
      method: 'POST',
      path: '/api/v1/auth/login',
      body: {},
      responseSchema: loginResponseSchema,
    });
    await expect(promise).rejects.toBeInstanceOf(ApiError);
    await expect(promise).rejects.toMatchObject({ kind: 'malformed', status: 200 });
  });

  it('strips a pendingToken that rides along on a successful login', async () => {
    // loginResponseSchema's success arm is not .strict(), so zod strips it.
    // Asserted here because it is a security property of the contract that the
    // client must not undo by casting instead of parsing.
    const fetchImpl = vi.fn(() =>
      Promise.resolve(jsonResponse({ mfaRequired: false, pendingToken: 'leaked' })),
    );
    const result = await clientWith(fetchImpl as unknown as typeof fetch).request({
      method: 'POST',
      path: '/api/v1/auth/login',
      body: {},
      responseSchema: loginResponseSchema,
    });
    expect(result).toEqual({ mfaRequired: false });
    expect(Object.keys(result)).not.toContain('pendingToken');
  });

  it('narrows the mfaRequired: true arm with its pendingToken', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(jsonResponse({ mfaRequired: true, pendingToken: 'pending-abc' })),
    );
    const result = await clientWith(fetchImpl as unknown as typeof fetch).request({
      method: 'POST',
      path: '/api/v1/auth/login',
      body: {},
      responseSchema: loginResponseSchema,
    });
    expect(result).toEqual({ mfaRequired: true, pendingToken: 'pending-abc' });
  });

  it('parses the session response with its contract schema', async () => {
    const session = {
      userId: 'usr_01JABCDEFGHJKMNPQRSTVWXYZ0',
      activeOrganization: null,
      permissions: [],
      entitlements: {},
    };
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse(session)));
    const result = await clientWith(fetchImpl as unknown as typeof fetch).request({
      method: 'GET',
      path: '/api/v1/auth/session',
      responseSchema: sessionResponseSchema,
    });
    expect(result).toEqual(session);
  });
});

describe('createApiClient — failures', () => {
  it('parses a non-2xx body with the error envelope and carries the request ID', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse(envelope(), 422)));
    const promise = clientWith(fetchImpl as unknown as typeof fetch).request({
      method: 'POST',
      path: '/api/v1/thing',
      body: {},
      responseSchema: okSchema,
    });
    await expect(promise).rejects.toMatchObject({
      kind: 'api',
      status: 422,
      code: 'VALIDATION_ERROR',
      requestId: 'req_01JABCDEF',
      message: 'The request body failed validation.',
    });
  });

  it('reads details.fields for VALIDATION_ERROR and for UNKNOWN_FIELD alike', async () => {
    for (const code of ['VALIDATION_ERROR', 'UNKNOWN_FIELD'] as const) {
      const body = envelope({
        code,
        details: { fields: [{ path: 'email', code: 'invalid_string', message: 'Not an email.' }] },
      });
      const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse(body, 422)));
      const error = await clientWith(fetchImpl as unknown as typeof fetch)
        .request({ method: 'POST', path: '/x', body: {}, responseSchema: okSchema })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).fieldErrors).toEqual([
        { path: 'email', code: 'invalid_string', message: 'Not an email.' },
      ]);
    }
  });

  it('tolerates a details.fields that is not the FieldError shape', async () => {
    const body = envelope({ code: 'VALIDATION_ERROR', details: { fields: 'nope' } });
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse(body, 422)));
    const error = await clientWith(fetchImpl as unknown as typeof fetch)
      .request({ method: 'POST', path: '/x', body: {}, responseSchema: okSchema })
      .catch((caught: unknown) => caught);
    expect((error as ApiError).fieldErrors).toEqual([]);
    expect((error as ApiError).message).toBe('The request body failed validation.');
  });

  it('reports a non-2xx body that is not the envelope as malformed, inventing no code', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse({ oops: true }, 500)));
    const error = await clientWith(fetchImpl as unknown as typeof fetch)
      .request({ method: 'GET', path: '/x', responseSchema: okSchema })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: 'malformed', status: 500, code: null, requestId: null });
  });

  it('reports a body that is not JSON at all rather than throwing a SyntaxError', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response('<html>502 Bad Gateway</html>', { status: 502 })),
    );
    const error = await clientWith(fetchImpl as unknown as typeof fetch)
      .request({ method: 'GET', path: '/x', responseSchema: okSchema })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ kind: 'malformed', status: 502 });
  });

  it('reports a fetch rejection as a network failure with no request ID', async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new TypeError('Failed to fetch')));
    const error = await clientWith(fetchImpl as unknown as typeof fetch)
      .request({ method: 'GET', path: '/x', responseSchema: okSchema })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: 'network', status: null, requestId: null });
  });

  it('the envelope fixture this suite uses is the real contract shape', () => {
    // Guards the rest of this file: if these fixtures drifted from
    // errorEnvelopeSchema, every assertion above would be testing a shape the
    // API never sends.
    expect(errorEnvelopeSchema.safeParse(envelope()).success).toBe(true);
  });
});
