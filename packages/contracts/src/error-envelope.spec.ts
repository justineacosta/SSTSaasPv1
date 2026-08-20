import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from './error-codes.js';
import { errorEnvelopeSchema } from './error-envelope.js';
import { collectionEnvelopeSchema } from './pagination.js';
import { z } from 'zod';

describe('errorEnvelopeSchema', () => {
  it('accepts a minimal envelope', () => {
    const parsed = errorEnvelopeSchema.parse({
      error: { code: ERROR_CODES.INTERNAL_ERROR, message: 'Something failed.', requestId: 'req_1' },
    });
    expect(parsed.error.code).toBe('INTERNAL_ERROR');
  });

  it('accepts a validation envelope with per-field errors', () => {
    const parsed = errorEnvelopeSchema.parse({
      error: {
        code: ERROR_CODES.VALIDATION_ERROR,
        message: 'The request contains invalid fields.',
        requestId: 'req_1',
        details: {
          fields: [{ path: 'targets[0]', code: 'invalid_host', message: 'Enter a valid hostname.' }],
        },
      },
    });
    expect(parsed.error.details).toBeDefined();
  });

  it('rejects an unknown error code, so codes cannot be invented ad hoc', () => {
    expect(() =>
      errorEnvelopeSchema.parse({
        error: { code: 'MADE_UP', message: 'x', requestId: 'req_1' },
      }),
    ).toThrow();
  });

  it('rejects an envelope without a requestId', () => {
    expect(() =>
      errorEnvelopeSchema.parse({ error: { code: ERROR_CODES.INTERNAL_ERROR, message: 'x' } }),
    ).toThrow();
  });
});

describe('collectionEnvelopeSchema', () => {
  it('wraps items with pagination and meta', () => {
    const schema = collectionEnvelopeSchema(z.object({ id: z.string() }));
    const parsed = schema.parse({
      data: [{ id: 'fnd_1' }],
      pagination: { nextCursor: 'abc', hasMore: true },
      meta: { total: 1284 },
    });
    expect(parsed.data).toHaveLength(1);
    expect(parsed.pagination.hasMore).toBe(true);
  });

  it('allows a null cursor on the last page', () => {
    const schema = collectionEnvelopeSchema(z.object({ id: z.string() }));
    const parsed = schema.parse({ data: [], pagination: { nextCursor: null, hasMore: false } });
    expect(parsed.pagination.nextCursor).toBeNull();
  });
});
