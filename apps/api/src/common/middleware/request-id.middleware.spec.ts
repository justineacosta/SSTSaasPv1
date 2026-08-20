import { describe, expect, it } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { getRequestContext } from '@sentinel/observability';
import { RequestIdMiddleware } from './request-id.middleware.js';

function run(headers: Record<string, string | string[] | undefined>): {
  requestId: string;
  headerValue: unknown;
  contextIdInsideNext: string | undefined;
} {
  const request = { headers } as unknown as Request;
  const written: Record<string, unknown> = {};
  const response = {
    setHeader: (name: string, value: unknown) => {
      written[name.toLowerCase()] = value;
    },
  } as unknown as Response;

  let contextIdInsideNext: string | undefined;
  const next: NextFunction = () => {
    contextIdInsideNext = getRequestContext()?.requestId;
  };

  new RequestIdMiddleware().use(request, response, next);

  return {
    requestId: (request as unknown as { id: string }).id,
    headerValue: written['x-request-id'],
    contextIdInsideNext,
  };
}

describe('RequestIdMiddleware', () => {
  it('generates a prefixed id when the client supplies none', () => {
    const { requestId, headerValue } = run({});
    expect(requestId).toMatch(/^req_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(headerValue).toBe(requestId);
  });

  it('echoes a well-formed client-supplied id', () => {
    const { requestId, headerValue } = run({ 'x-request-id': 'req_supplied' });
    expect(requestId).toBe('req_supplied');
    expect(headerValue).toBe('req_supplied');
  });

  it.each([
    ['a newline, which would forge a second log line', 'req_a\nlevel=fatal msg=owned'],
    ['a carriage return', 'req_a\r\nX-Evil: 1'],
    ['characters outside the safe alphabet', 'req_<script>alert(1)</script>'],
    ['an oversized value', `req_${'a'.repeat(400)}`],
    ['an empty value', ''],
    ['whitespace only', '   '],
  ])('refuses a client-supplied id containing %s and generates its own', (_why, supplied) => {
    // The request ID is written into structured logs and reflected in a response
    // header. It is client-controlled input and is validated like any other.
    const { requestId, headerValue } = run({ 'x-request-id': supplied });
    expect(requestId).not.toBe(supplied);
    expect(requestId).toMatch(/^req_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(headerValue).toBe(requestId);
  });

  it('refuses a repeated header, which Express surfaces as an array', () => {
    const { requestId } = run({ 'x-request-id': ['req_one', 'req_two'] });
    expect(requestId).toMatch(/^req_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('makes the id ambient for the rest of the request', () => {
    const { requestId, contextIdInsideNext } = run({ 'x-request-id': 'req_supplied' });
    expect(contextIdInsideNext).toBe(requestId);
  });

  it('leaves no ambient context behind once the request is over', () => {
    run({});
    expect(getRequestContext()).toBeUndefined();
  });
});
