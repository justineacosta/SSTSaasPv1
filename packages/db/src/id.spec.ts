import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ID_PREFIXES, newId, parseIdPrefix } from './id.js';

describe('newId', () => {
  it('produces a prefixed, 26-character Crockford base32 identifier', () => {
    const id = newId('org');
    expect(id).toMatch(/^org_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('produces unique identifiers under a tight loop', () => {
    const ids = new Set(Array.from({ length: 10_000 }, () => newId('fnd')));
    expect(ids.size).toBe(10_000);
  });

  it('sorts chronologically as a string, which is what gives index locality', async () => {
    const first = newId('scn');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = newId('scn');
    expect(first < second).toBe(true);
  });

  // Two IDs 5ms apart differ in their timestamp bytes regardless of whether
  // the base32 alphabet is even in the right order, so the test above can't
  // catch an alphabet-ordering bug (e.g. two characters transposed). Most
  // generations in a tight loop land in the same millisecond, where ordering
  // depends entirely on encoding the trailing bits with a monotonically
  // increasing alphabet — this is what actually exercises that.
  it('sorts chronologically across many same-millisecond generations', () => {
    const ids = Array.from({ length: 1000 }, () => newId('scn'));
    expect([...ids].sort()).toEqual(ids);
  });

  it('exposes a prefix for every entity type the API returns', () => {
    expect(ID_PREFIXES.org).toBe('org');
    expect(ID_PREFIXES.usr).toBe('usr');
    expect(ID_PREFIXES.aud).toBe('aud');
  });

  it('round-trips the prefix', () => {
    expect(parseIdPrefix(newId('mbr'))).toBe('mbr');
  });

  it('returns undefined for a string that is not one of our identifiers', () => {
    expect(parseIdPrefix('not-an-id')).toBeUndefined();
    // Contains I/O/U, which Crockford base32 excludes — this rejects on the
    // charset regex before ever reaching the registry check below, so on its
    // own it does not prove the registry guard exists.
    expect(parseIdPrefix('xyz_01J8XK2P9V3QWERTYUIOPASDF')).toBeUndefined();
  });

  it('rejects a syntactically valid but unregistered prefix', () => {
    // Same shape as a real ID — three lowercase letters, underscore, 26
    // valid Crockford characters — but 'xyz' is not a key in ID_PREFIXES.
    // Deleting the `candidate in ID_PREFIXES` guard would let this through.
    const body = newId('org').slice(4);
    expect(parseIdPrefix(`xyz_${body}`)).toBeUndefined();
  });

  it('rejects a well-formed identifier preceded by extra characters', () => {
    expect(parseIdPrefix(`garbage-${newId('org')}`)).toBeUndefined();
  });
});

/**
 * THE DOCSTRING'S OWN EXAMPLES MUST PARSE.
 *
 * `newId`'s docstring shipped an illustrative-looking identifier that
 * `parseIdPrefix()` rejected: 25 body characters where ID_BODY_LENGTH is 26,
 * and containing U, I and O, three of the four letters the Crockford alphabet
 * excludes. It survived Phase 1 because no test ever read it.
 *
 * This reads id.ts itself and checks every backticked ID-shaped example in the
 * file, rather than asserting against a copy pasted into this spec — a copy is
 * a second place to be wrong, and drifts the moment somebody edits only one of
 * them. The source file is the single copy; this is a reader of it.
 */
const ID_EXAMPLE_PATTERN = /`([a-z]{3}_[0-9A-Z]+)`/g;

function docstringExamples(): string[] {
  const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'id.ts'), 'utf8');
  return [...source.matchAll(ID_EXAMPLE_PATTERN)].map(([, example]) => example as string);
}

describe("id.ts's own documented examples", () => {
  it('finds at least one example to check, rather than passing vacuously', () => {
    expect(docstringExamples().length).toBeGreaterThan(0);
  });

  it('parses every ID-shaped example the file shows', () => {
    for (const example of docstringExamples()) {
      expect(parseIdPrefix(example), `docstring example ${example} does not parse`).toBe(
        example.slice(0, 3),
      );
    }
  });
});
