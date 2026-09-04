import type { FieldError } from '@sentinel/contracts';
import { describe, expect, it } from 'vitest';
import { ApiError } from './errors';
import {
  distributeFieldErrors,
  formLevelMessage,
  rootSegment,
  serverFormErrors,
} from './field-errors';

const field = (path: string, message: string): FieldError => ({
  path,
  code: 'invalid_string',
  message,
});

describe('rootSegment', () => {
  it('returns a flat path unchanged', () => {
    expect(rootSegment('email')).toBe('email');
  });

  it('takes the segment before a dot', () => {
    expect(rootSegment('scope.rules')).toBe('scope');
  });

  it('takes the segment before a bracket', () => {
    expect(rootSegment('targets[0]')).toBe('targets');
  });

  it('takes whichever boundary comes first', () => {
    expect(rootSegment('scope.rules[2].value')).toBe('scope');
    expect(rootSegment('targets[0].host')).toBe('targets');
  });
});

describe('distributeFieldErrors', () => {
  it('puts an error for a rendered field on that field', () => {
    const result = distributeFieldErrors([field('email', 'Not an email.')], ['email', 'password']);
    expect(result.matched).toEqual([{ field: 'email', message: 'Not an email.' }]);
    expect(result.unmatched).toEqual([]);
  });

  it('matches a nested path back to the control that owns it', () => {
    const result = distributeFieldErrors([field('targets[0]', 'Bad host.')], ['targets']);
    expect(result.matched).toEqual([{ field: 'targets', message: 'Bad host.' }]);
  });

  it('DOES NOT DROP a path the form does not render', () => {
    // The whole reason this function exists. Dropping it produces a form that
    // refuses to submit while showing no error at all.
    const result = distributeFieldErrors(
      [field('organizationSlug', 'Already in use.')],
      ['email', 'password'],
    );
    expect(result.matched).toEqual([]);
    expect(result.unmatched).toEqual([field('organizationSlug', 'Already in use.')]);
  });

  it('splits a mixed batch in both directions', () => {
    const result = distributeFieldErrors(
      [field('email', 'Not an email.'), field('captcha', 'Missing.')],
      ['email', 'password'],
    );
    expect(result.matched).toEqual([{ field: 'email', message: 'Not an email.' }]);
    expect(result.unmatched).toEqual([field('captcha', 'Missing.')]);
  });

  it('keeps the first error per field and moves the rest to unmatched, not to nowhere', () => {
    const result = distributeFieldErrors(
      [field('password', 'Too short.'), field('password', 'Breached.')],
      ['password'],
    );
    expect(result.matched).toEqual([{ field: 'password', message: 'Too short.' }]);
    expect(result.unmatched).toEqual([field('password', 'Breached.')]);
  });

  it('is empty in both halves when there are no field errors', () => {
    expect(distributeFieldErrors([], ['email'])).toEqual({ matched: [], unmatched: [] });
  });
});

describe('formLevelMessage', () => {
  const error = new ApiError({
    kind: 'api',
    status: 422,
    code: 'VALIDATION_ERROR',
    message: 'The request body failed validation.',
    requestId: 'req_1',
  });

  it('is the server message when everything mapped onto a control', () => {
    expect(formLevelMessage(error, [])).toBe('The request body failed validation.');
  });

  it('appends every unmatched path so none is invisible', () => {
    const message = formLevelMessage(error, [
      field('captcha', 'Missing.'),
      field('tenant', 'Unknown.'),
    ]);
    expect(message).toContain('captcha: Missing.');
    expect(message).toContain('tenant: Unknown.');
  });
});

describe('serverFormErrors', () => {
  it('carries the request ID through for the error state to render', () => {
    const error = new ApiError({
      kind: 'api',
      status: 422,
      code: 'VALIDATION_ERROR',
      message: 'The request body failed validation.',
      requestId: 'req_01JXYZ',
      fieldErrors: [field('email', 'Not an email.')],
    });
    const result = serverFormErrors(error, ['email', 'password']);
    expect(result.requestId).toBe('req_01JXYZ');
    expect(result.fieldErrors).toEqual([{ field: 'email', message: 'Not an email.' }]);
    expect(result.formMessage).toBe('The request body failed validation.');
  });

  it('still produces a message for a rejection that is not an ApiError', () => {
    const result = serverFormErrors(new TypeError('boom'), ['email']);
    expect(result.formMessage.length).toBeGreaterThan(0);
    expect(result.fieldErrors).toEqual([]);
    expect(result.requestId).toBeNull();
  });

  it('has no request ID for a network failure, because the server never answered', () => {
    const result = serverFormErrors(
      new ApiError({ kind: 'network', message: 'Could not reach the Sentinel API.' }),
      ['email'],
    );
    expect(result.requestId).toBeNull();
    expect(result.formMessage).toBe('Could not reach the Sentinel API.');
  });
});
