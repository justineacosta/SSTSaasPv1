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

/**
 * `UNKNOWN_FIELD` (errors.md §3) had no producer anywhere in the repository
 * until this branch: it was a documented code that nothing could raise. §7 of
 * that document names no code — it states the general rule that every
 * documented code has at least one test that produces it, and this code had no
 * producer for such a test to call. `packages/contracts` cannot close that — a
 * schema has no status code — so the split lives here, in the one place that
 * turns a Zod failure into an HTTP error.
 */
const strictSchema = z
  .object({
    name: z.string().min(3),
    nested: z.object({ value: z.string() }).strict(),
  })
  .strict();

function failWithStrict(input: unknown): DomainError {
  try {
    new ZodValidationPipe(strictSchema).transform(input);
  } catch (error) {
    return error as DomainError;
  }
  throw new Error('Expected the pipe to reject this input, but it accepted it.');
}

describe('ZodValidationPipe and unknown fields', () => {
  it('raises UNKNOWN_FIELD at 400 when every issue is an unrecognised key', () => {
    const error = failWithStrict({ name: 'abc', nested: { value: 'v' }, organisationId: 'typo' });
    expect(error.code).toBe(ERROR_CODES.UNKNOWN_FIELD);
    expect(error.status).toBe(400);
  });

  it('names the offending key, with the full path the client sent', () => {
    // Zod puts the PARENT path on an `unrecognized_keys` issue and the keys in
    // `issue.keys`, so formatting the issue path alone would emit an empty
    // path and name no field at all — a 400 that says "there is an unknown
    // field somewhere" is not actionable.
    const error = failWithStrict({ name: 'abc', nested: { value: 'v', extar: 1 } });
    expect(fieldsOf(error).map((field) => field.path)).toEqual(['nested.extar']);
  });

  it('reports one field error per unrecognised key, not one per object', () => {
    const error = failWithStrict({ name: 'abc', nested: { value: 'v' }, a: 1, b: 2 });
    const paths = fieldsOf(error).map((field) => field.path);
    expect(paths.sort()).toEqual(['a', 'b']);
  });

  it('stays VALIDATION_ERROR when a real validation rule also failed', () => {
    // A body that both misspells a field AND breaks a rule is a validation
    // failure. Branching it to UNKNOWN_FIELD would tell the client the only
    // problem was the spelling, and it would fix the spelling and fail again.
    const error = failWithStrict({ name: 'ab', nested: { value: 'v' }, extra: 1 });
    expect(error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
  });

  it('still lists the unrecognised keys on a mixed failure', () => {
    // The code is the weaker signal; `details.fields` is what a form binds to.
    // Losing the unknown key from a mixed failure would make the client's
    // second attempt fail for the same reason as the first.
    const error = failWithStrict({ name: 'ab', nested: { value: 'v' }, extra: 1 });
    const paths = fieldsOf(error).map((field) => field.path);
    expect(paths).toContain('name');
    expect(paths).toContain('extra');
  });

  it('carries the Zod issue code on each unknown-field entry', () => {
    const error = failWithStrict({ name: 'abc', nested: { value: 'v' }, extra: 1 });
    expect(fieldsOf(error).map((field) => field.code)).toEqual(['unrecognized_keys']);
  });

  it('redacts secret-shaped content out of an unknown key name', () => {
    // The key is the caller's own input and is echoed back in `path` and
    // `message`. errors.md §5 — client-visible text goes through the same
    // redaction the logger uses.
    const error = failWithStrict({
      name: 'abc',
      nested: { value: 'v' },
      'https://user:hunter2@internal.example/cb': 1,
    });
    expect(JSON.stringify(error.details)).not.toContain('hunter2');
  });

  it('carries nothing but fields in details on an unknown-field failure', () => {
    const error = failWithStrict({ name: 'abc', nested: { value: 'v' }, extra: 1 });
    expect(Object.keys(error.details ?? {})).toEqual(['fields']);
  });
});
