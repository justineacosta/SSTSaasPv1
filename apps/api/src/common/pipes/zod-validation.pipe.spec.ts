import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ERROR_CODES, fieldErrorSchema } from '@sentinel/contracts';
import { DomainError } from '../errors/domain-error.js';
import { ZodValidationPipe } from './zod-validation.pipe.js';

const schema = z.object({
  name: z.string().min(3),
  port: z.coerce.number().int(),
  targets: z.array(z.string().url()),
  scope: z.object({ rules: z.array(z.object({ value: z.string().min(1) })) }),
});

function failWith(input: unknown): DomainError {
  try {
    new ZodValidationPipe(schema).transform(input);
  } catch (error) {
    return error as DomainError;
  }
  throw new Error('Expected the pipe to reject this input, but it accepted it.');
}

function fieldsOf(error: DomainError): { path: string; code: string; message: string }[] {
  return z.array(fieldErrorSchema).parse((error.details as { fields: unknown }).fields);
}

describe('ZodValidationPipe', () => {
  it('returns the parsed value, with the schema transforms applied', () => {
    const parsed = new ZodValidationPipe(schema).transform({
      name: 'abc',
      port: '8080',
      targets: ['https://example.com'],
      scope: { rules: [{ value: 'x' }] },
    });
    // Coercion is the point: the handler must receive a number, not the string
    // the query string actually carried.
    expect(parsed).toEqual({
      name: 'abc',
      port: 8080,
      targets: ['https://example.com'],
      scope: { rules: [{ value: 'x' }] },
    });
  });

  it('throws a 400 VALIDATION_ERROR domain error', () => {
    const error = failWith({ name: 'ab', port: 'x', targets: [], scope: { rules: [] } });
    expect(error).toBeInstanceOf(DomainError);
    expect(error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
    expect(error.status).toBe(400);
  });

  it('reports one entry per failing field, in the FieldError shape', () => {
    const error = failWith({ name: 'ab', port: 'x', targets: [], scope: { rules: [] } });
    const fields = fieldsOf(error);
    expect(fields.map((field) => field.path).sort()).toEqual(['name', 'port']);
    for (const field of fields) {
      expect(field.code.length).toBeGreaterThan(0);
      expect(field.message.length).toBeGreaterThan(0);
    }
  });

  it('uses dotted/bracketed paths that match the request body', () => {
    const error = failWith({
      name: 'abc',
      port: 1,
      targets: ['not-a-url'],
      scope: { rules: [{ value: 'ok' }, { value: '' }] },
    });
    const paths = fieldsOf(error).map((field) => field.path);
    // errors.md §2 — the client attaches these to inputs without guessing.
    expect(paths).toContain('targets[0]');
    expect(paths).toContain('scope.rules[1].value');
  });

  it('describes a root-level failure with an empty path rather than inventing one', () => {
    const error = failWith('not an object at all');
    expect(fieldsOf(error).map((field) => field.path)).toEqual(['']);
  });

  it('never echoes secret-shaped content out of a Zod message', () => {
    // Zod's `invalid_enum_value` message quotes the received value verbatim.
    // The pipe's output is client-visible, so it goes through the same
    // substring redaction the logger uses. errors.md §5.
    const enumSchema = z.object({ mode: z.enum(['fast', 'deep']) });
    let caught: DomainError | undefined;
    try {
      new ZodValidationPipe(enumSchema).transform({
        mode: 'https://user:hunter2@internal.example/cb',
      });
    } catch (error) {
      caught = error as DomainError;
    }
    expect(caught).toBeDefined();
    expect(JSON.stringify(caught?.details)).not.toContain('hunter2');
  });

  it('carries nothing but fields in details', () => {
    const error = failWith({ name: 'ab', port: 1, targets: [], scope: { rules: [] } });
    expect(Object.keys(error.details ?? {})).toEqual(['fields']);
  });
});
