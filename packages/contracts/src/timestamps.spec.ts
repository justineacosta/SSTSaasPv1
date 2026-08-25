import { describe, expect, it } from 'vitest';
import { isoTimestampSchema } from './timestamps.js';

/**
 * Every timestamp field in every response schema is this one schema, so what it
 * accepts is the API's timestamp format for the whole of Phase 2. These
 * assertions record what it accepts TODAY, measured rather than assumed —
 * `z.string().datetime({ offset: true })` is a Zod behaviour, and a Zod upgrade
 * that widened or narrowed it would otherwise change the wire contract with
 * nobody noticing.
 */
describe('isoTimestampSchema', () => {
  it('accepts a UTC instant with a `Z` designator — the form the API emits', () => {
    expect(isoTimestampSchema.parse('2026-08-20T14:30:00Z')).toBe('2026-08-20T14:30:00Z');
    expect(isoTimestampSchema.safeParse('2026-08-20T14:30:00.123Z').success).toBe(true);
  });

  it('rejects a bare date with no time at all', () => {
    // `2026-08-20` is a day, not an instant. Accepting one would let a handler
    // send a value every client has to guess a time zone for.
    expect(isoTimestampSchema.safeParse('2026-08-20').success).toBe(false);
  });

  it('rejects a local time with no offset', () => {
    // conventions.md §3's actual bite. `2026-08-20T14:30:00` is ambiguous by
    // an hour twice a year and by the reader's guess about the server's zone
    // the rest of the time.
    expect(isoTimestampSchema.safeParse('2026-08-20T14:30:00').success).toBe(false);
  });

  it('rejects a `Date` object, because a `Date` is not a JSON type', () => {
    // The trap this schema exists to close: a `Date` in a response schema
    // serialises through whatever `toJSON` the runtime provides, so a schema
    // accepting one would accept a value the API can never actually send.
    expect(isoTimestampSchema.safeParse(new Date('2026-08-20T14:30:00Z')).success).toBe(false);
    expect(isoTimestampSchema.safeParse(1_755_699_000_000).success).toBe(false);
  });

  it('rejects a syntactically invalid instant', () => {
    expect(isoTimestampSchema.safeParse('2026-08-20T25:00:00Z').success).toBe(false);
    expect(isoTimestampSchema.safeParse('2026-08-20t14:30:00Z').success).toBe(false);
    expect(isoTimestampSchema.safeParse('').success).toBe(false);
  });

  it('ALSO accepts an explicit non-UTC offset, which is wider than what the API emits', () => {
    // Recorded as a known gap rather than left to be discovered. conventions.md
    // §3 says "ISO 8601 with offset, always UTC", and `{ offset: true }`
    // enforces the first half but not the second: `+01:00` parses.
    //
    // Deliberately NOT narrowed to `Z`-only here. `2026-08-20T15:30:00+01:00`
    // denotes the same instant as `2026-08-20T14:30:00Z` — it is unambiguous,
    // which is the property §3 is protecting — so refusing it would buy
    // house-style uniformity, not correctness, at the price of narrowing a
    // response shape, and narrowing is the breaking direction under
    // conventions.md §8. What matters is that the API's own serialisation
    // emits `Z`; that is a handler-side obligation, and this schema is not the
    // thing that can enforce it.
    expect(isoTimestampSchema.safeParse('2026-08-20T14:30:00+01:00').success).toBe(true);
  });
});
