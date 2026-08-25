import { describe, expect, it } from 'vitest';
import {
  cursorSchema,
  LIST_LIMIT_DEFAULT,
  LIST_LIMIT_MAX,
  listQuerySchema,
  paginationSchema,
} from './pagination.js';

describe('paginationSchema', () => {
  it('echoes the applied limit, which is the only way a client sees its request was clamped', () => {
    // pagination.md §1's envelope is `{ nextCursor, hasMore, limit }` and §4
    // says the clamped limit is echoed in `pagination.limit`. Without this
    // field a client asking for 500 receives 100 rows and cannot distinguish
    // "clamped" from "that is all there was" — so it stops paginating, having
    // silently seen a fifth of the data it asked for.
    expect(paginationSchema.parse({ nextCursor: null, hasMore: false, limit: 50 }).limit).toBe(50);
  });

  it('requires the limit — an envelope without one is not the documented shape', () => {
    expect(paginationSchema.safeParse({ nextCursor: null, hasMore: false }).success).toBe(false);
  });

  it('bounds the echoed limit by LIST_LIMIT_MAX and refuses a non-positive integer', () => {
    // The echo has to be bounded by the same maximum the query clamps to. An
    // unbounded echo would let a handler report back the 500 the client asked
    // for while having applied 100 — a lie that looks like a working contract.
    expect(
      paginationSchema.safeParse({ nextCursor: null, hasMore: false, limit: LIST_LIMIT_MAX })
        .success,
    ).toBe(true);
    expect(
      paginationSchema.safeParse({ nextCursor: null, hasMore: false, limit: LIST_LIMIT_MAX + 1 })
        .success,
    ).toBe(false);
    expect(paginationSchema.safeParse({ nextCursor: null, hasMore: false, limit: 0 }).success).toBe(
      false,
    );
    expect(
      paginationSchema.safeParse({ nextCursor: null, hasMore: false, limit: 1.5 }).success,
    ).toBe(false);
  });
});

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
