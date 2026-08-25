import { describe, expect, it } from 'vitest';
import { cursorSchema, LIST_LIMIT_DEFAULT, LIST_LIMIT_MAX, listQuerySchema } from './pagination.js';

describe('listQuerySchema', () => {
  it('applies a default limit when the client asks for none', () => {
    // "Every list endpoint paginates. There are no unbounded list endpoints."
    // A query with no limit must not mean "all rows".
    expect(listQuerySchema.parse({})).toEqual({ limit: LIST_LIMIT_DEFAULT });
  });

  it('coerces the limit from the string a query string actually carries', () => {
    expect(listQuerySchema.parse({ limit: '25' }).limit).toBe(25);
  });

  it('clamps a limit above the maximum rather than rejecting it', () => {
    // pagination.md §4 — clamped, not rejected.
    expect(listQuerySchema.parse({ limit: 5000 }).limit).toBe(LIST_LIMIT_MAX);
  });

  it('rejects a limit below one, and a non-integer limit', () => {
    expect(listQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(listQuerySchema.safeParse({ limit: -1 }).success).toBe(false);
    expect(listQuerySchema.safeParse({ limit: 1.5 }).success).toBe(false);
  });

  it('accepts an opaque cursor and does not attempt to interpret it', () => {
    const cursor = 'eyJzIjoiMjAyNi0wOC0yMFQxNDozMDowMFoiLCJpIjoiZm5kXzAxSiJ9';
    expect(listQuerySchema.parse({ cursor }).cursor).toBe(cursor);
  });

  it('bounds the cursor length, because an unbounded one is free memory for a caller', () => {
    expect(cursorSchema.safeParse('x'.repeat(10_000)).success).toBe(false);
    expect(cursorSchema.safeParse('').success).toBe(false);
  });

  it('rejects an unknown query parameter', () => {
    // A misspelled filter that is silently ignored returns the wrong rows and
    // looks like a server bug. api/conventions.md §3.
    const result = listQuerySchema.safeParse({ limit: 10, sort: 'createdAt:desc' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.code).toBe('unrecognized_keys');
  });
});
