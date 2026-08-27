import { describe, expect, it } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { CorsMiddleware } from './cors.middleware.js';

const ALLOWED = 'https://app.sentinel.test';

interface Run {
  readonly headers: Record<string, string>;
  readonly nextCalled: boolean;
  readonly ended: boolean;
  readonly status: number | undefined;
}

function run(options: {
  origin?: string | undefined;
  method?: string | undefined;
  preflight?: boolean | undefined;
  existingVary?: string | undefined;
}): Run {
  const headers: Record<string, string> = {};
  let nextCalled = false;
  let ended = false;
  let status: number | undefined;

  const request = {
    method: options.method ?? 'GET',
    headers: {
      ...(options.origin === undefined ? {} : { origin: options.origin }),
      ...(options.preflight === true ? { 'access-control-request-method': 'POST' } : {}),
    },
  } as unknown as Request;

  const response = {
    getHeader: (name: string) => (name === 'Vary' ? options.existingVary : undefined),
    setHeader: (name: string, value: string) => {
      headers[name] = value;
    },
    set statusCode(value: number) {
      status = value;
    },
    get statusCode(): number {
      return status ?? 200;
    },
    end: () => {
      ended = true;
    },
  } as unknown as Response;

  new CorsMiddleware(ALLOWED).use(request, response, (() => {
    nextCalled = true;
  }) as NextFunction);

  return { headers, nextCalled, ended, status };
}

describe('an allowed origin', () => {
  it('gets the CONFIGURED origin back, with credentials', () => {
    const { headers } = run({ origin: ALLOWED });
    expect(headers['Access-Control-Allow-Origin']).toBe(ALLOWED);
    expect(headers['Access-Control-Allow-Credentials']).toBe('true');
  });

  it('can read the request ID and the rate-limit headers', () => {
    const exposed = run({ origin: ALLOWED }).headers['Access-Control-Expose-Headers'] ?? '';
    expect(exposed).toContain('X-Request-Id');
    expect(exposed).toContain('RateLimit-Remaining');
    expect(exposed).toContain('Retry-After');
  });

  it('continues to the router for an ordinary request', () => {
    expect(run({ origin: ALLOWED }).nextCalled).toBe(true);
  });
});

describe('an origin that is not on the list', () => {
  it('receives NO Access-Control-Allow-Origin header at all', () => {
    // ADR-0017's first named property. Not a header naming a different origin,
    // and certainly not one naming the caller: none.
    const { headers } = run({ origin: 'https://evil.test' });
    expect(headers['Access-Control-Allow-Origin']).toBeUndefined();
    expect(headers['Access-Control-Allow-Credentials']).toBeUndefined();
  });

  it('is refused for a near miss, which is the classic pattern bug', () => {
    // Every one of these matches some carelessly written regular expression and
    // none of them is this origin. An exact string comparison has no such
    // failure mode, which is ADR-0017's stated reason for choosing one.
    for (const origin of [
      `${ALLOWED}.evil.test`,
      'https://evil-app.sentinel.test',
      `${ALLOWED}:8443`,
      ALLOWED.replace('https', 'http'),
      `${ALLOWED}/`,
    ]) {
      expect(run({ origin }).headers['Access-Control-Allow-Origin']).toBeUndefined();
    }
  });

  it('is never answered with a wildcard', () => {
    // ADR-0017's second named property. `*` with credentials is rejected by
    // browsers, so the failure would be loud — but the tempting fix for a CORS
    // error is to widen the origin, and this widening breaks the product rather
    // than opening it, which is a confusing symptom for a real bug's neighbour.
    for (const origin of [ALLOWED, 'https://evil.test', undefined]) {
      expect(Object.values(run({ origin }).headers)).not.toContain('*');
    }
  });

  it('still reaches the router — CORS is not the authorization control', () => {
    // ADR-0017's third named property. A non-browser client ignores all of this,
    // so the request must still be evaluated by the guards that actually refuse
    // it rather than being silently dropped here.
    expect(run({ origin: 'https://evil.test' }).nextCalled).toBe(true);
  });
});

describe('a request with no Origin header', () => {
  it('gets no CORS headers and continues', () => {
    const { headers, nextCalled } = run({});
    expect(headers['Access-Control-Allow-Origin']).toBeUndefined();
    expect(nextCalled).toBe(true);
  });
});

describe('Vary', () => {
  it('is set on every response, allowed or not', () => {
    // Setting it only on the allowed branch is the subtle version of the bug: a
    // shared cache would hand an allowed origin's response, CORS headers
    // included, to a different origin.
    expect(run({ origin: ALLOWED }).headers['Vary']).toBe('Origin');
    expect(run({ origin: 'https://evil.test' }).headers['Vary']).toBe('Origin');
    expect(run({}).headers['Vary']).toBe('Origin');
  });

  it('appends rather than clobbering what another stage set', () => {
    expect(run({ origin: ALLOWED, existingVary: 'Accept-Encoding' }).headers['Vary']).toBe(
      'Accept-Encoding, Origin',
    );
  });
});

describe('preflight', () => {
  it('is answered here with 204 and never reaches the router', () => {
    // It carries no credentials and identifies no user: reaching the rate
    // limiter would charge a real request's budget to a browser's bookkeeping,
    // and reaching the authentication guard would 401 it.
    const { status, ended, nextCalled } = run({
      origin: ALLOWED,
      method: 'OPTIONS',
      preflight: true,
    });
    expect(status).toBe(204);
    expect(ended).toBe(true);
    expect(nextCalled).toBe(false);
  });

  it('enumerates the methods and the request headers', () => {
    const { headers } = run({ origin: ALLOWED, method: 'OPTIONS', preflight: true });
    expect(headers['Access-Control-Allow-Methods']).toContain('PATCH');
    expect(headers['Access-Control-Allow-Headers']).toContain('X-CSRF-Token');
    expect(headers['Access-Control-Max-Age']).toBe('600');
  });

  it('does not advertise Authorization, which no browser path uses', () => {
    // API keys are the machine credential and Phase 2 issues none. Listing the
    // header now would widen the browser-reachable surface for a credential
    // type nothing can yet obtain.
    expect(
      run({ origin: ALLOWED, method: 'OPTIONS', preflight: true }).headers[
        'Access-Control-Allow-Headers'
      ],
    ).not.toContain('Authorization');
  });

  it('from a disallowed origin gets 204 with no CORS headers, not a distinct status', () => {
    // A different status would let a scanner discover the allowlist one guess at
    // a time. The browser blocks on the absent header either way.
    const { status, headers, nextCalled } = run({
      origin: 'https://evil.test',
      method: 'OPTIONS',
      preflight: true,
    });
    expect(status).toBe(204);
    expect(nextCalled).toBe(false);
    expect(headers['Access-Control-Allow-Origin']).toBeUndefined();
    expect(headers['Access-Control-Allow-Methods']).toBeUndefined();
  });

  it('leaves a plain OPTIONS without the preflight header to the router', () => {
    // An OPTIONS carrying no `Access-Control-Request-Method` is an ordinary
    // request, not a preflight, and swallowing it here would hide a route.
    expect(run({ origin: ALLOWED, method: 'OPTIONS' }).nextCalled).toBe(true);
  });
});
