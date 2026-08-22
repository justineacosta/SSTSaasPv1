import { describe, expect, it } from 'vitest';
import {
  diffJsonValues,
  formatDifferences,
  hasBreakingDifference,
  isProseOnlyPath,
  type JsonDifference,
} from './check-openapi-diff.js';

describe('diffJsonValues', () => {
  it('returns nothing for two identical documents', () => {
    const document = { openapi: '3.0.3', paths: { '/health/live': { get: { operationId: 'a' } } } };
    expect(diffJsonValues(document, structuredClone(document))).toEqual([]);
  });

  it('names the exact path of a changed leaf', () => {
    expect(diffJsonValues({ info: { version: '1' } }, { info: { version: '2' } })).toEqual<
      JsonDifference[]
    >([{ path: 'info.version', kind: 'changed', committed: '"1"', generated: '"2"' }]);
  });

  it('reports a field the generator added', () => {
    expect(diffJsonValues({ paths: {} }, { paths: { '/x': { get: {} } } })).toEqual<
      JsonDifference[]
    >([{ path: 'paths./x', kind: 'added', generated: '{"get":{}}' }]);
  });

  it('reports a field the generator no longer emits', () => {
    expect(diffJsonValues({ paths: { '/x': 1 } }, { paths: {} })).toEqual<JsonDifference[]>([
      { path: 'paths./x', kind: 'removed', committed: '1' },
    ]);
  });

  it('reports every difference, not just the first', () => {
    const differences = diffJsonValues({ a: 1, b: 2, c: 3 }, { a: 9, b: 2, c: 8 });
    expect(differences.map((difference) => difference.path)).toEqual(['a', 'c']);
  });

  it('treats array order as significant', () => {
    // An OpenAPI `required` array whose members were reordered is a real change
    // to the document, and the byte-identity gate will fail on it.
    const differences = diffJsonValues({ required: ['a', 'b'] }, { required: ['b', 'a'] });
    expect(differences.map((difference) => difference.path)).toEqual([
      'required[0]',
      'required[1]',
    ]);
  });

  it('reports an appended array element as added', () => {
    expect(diffJsonValues({ tags: ['a'] }, { tags: ['a', 'b'] })).toEqual<JsonDifference[]>([
      { path: 'tags[1]', kind: 'added', generated: '"b"' },
    ]);
  });

  it('distinguishes a missing key from a key set to null', () => {
    expect(diffJsonValues({}, { x: null }).map((d) => d.kind)).toEqual(['added']);
    expect(diffJsonValues({ x: null }, { x: undefined }).map((d) => d.kind)).toEqual(['changed']);
  });

  it('reports a type change at the document root', () => {
    expect(diffJsonValues('a', 'b')).toEqual<JsonDifference[]>([
      { path: '(document)', kind: 'changed', committed: '"a"', generated: '"b"' },
    ]);
  });
});

describe('hasBreakingDifference', () => {
  it('is false when the generator only adds', () => {
    // Additive changes ship in place under api/conventions.md §8.
    expect(hasBreakingDifference([{ path: 'paths./x', kind: 'added', generated: '{}' }])).toBe(
      false,
    );
  });

  it('is true when something was removed', () => {
    expect(hasBreakingDifference([{ path: 'paths./x', kind: 'removed', committed: '{}' }])).toBe(
      true,
    );
  });

  it('is true when a value changed type or content', () => {
    expect(
      hasBreakingDifference([
        { path: 'x', kind: 'changed', committed: '"string"', generated: '"number"' },
      ]),
    ).toBe(true);
  });
});

describe('formatDifferences', () => {
  it('marks removals with - and additions with +, so a red log reads as a diff', () => {
    expect(
      formatDifferences([
        { path: 'a', kind: 'removed', committed: '1' },
        { path: 'b', kind: 'added', generated: '2' },
      ]),
    ).toEqual(['  - a  1', '  + b  2']);
  });

  it('shows both sides of a change', () => {
    expect(
      formatDifferences([{ path: 'a', kind: 'changed', committed: '1', generated: '2' }]),
    ).toEqual(['  ~ a\n      committed: 1\n      generated: 2']);
  });
});

describe('isProseOnlyPath', () => {
  it('treats every info.* field as prose', () => {
    // A review edited info.description — free text no client consumes — and got
    // the full "this needs /api/v2" banner. A banner that fires on every
    // docstring tweak is a banner people learn to skim past.
    expect(isProseOnlyPath('info.description')).toBe(true);
    expect(isProseOnlyPath('info.title')).toBe(true);
    expect(isProseOnlyPath('info.version')).toBe(true);
  });

  it('treats description and summary as prose at any depth', () => {
    expect(isProseOnlyPath('paths./health/live.get.description')).toBe(true);
    expect(isProseOnlyPath('paths./health/live.get.summary')).toBe(true);
  });

  it('does not treat contract-bearing fields as prose', () => {
    expect(isProseOnlyPath('paths./health/live.get.operationId')).toBe(false);
    expect(isProseOnlyPath('components.schemas.Error.required[0]')).toBe(false);
    expect(isProseOnlyPath('openapi')).toBe(false);
  });

  it('is not fooled by a field whose name merely ends in the word', () => {
    expect(isProseOnlyPath('paths./x.get.responses.200.contentDescription')).toBe(false);
  });
});

describe('hasBreakingDifference, prose exemption', () => {
  it('does not call a docstring edit breaking', () => {
    expect(
      hasBreakingDifference([
        { path: 'info.description', kind: 'changed', committed: '"A"', generated: '"B"' },
      ]),
    ).toBe(false);
  });

  it('still calls an operationId rename breaking', () => {
    expect(
      hasBreakingDifference([
        { path: 'paths./x.get.operationId', kind: 'changed', committed: '"a"', generated: '"b"' },
      ]),
    ).toBe(true);
  });

  it('still calls a removal breaking even on a prose path sibling', () => {
    expect(
      hasBreakingDifference([
        { path: 'info.description', kind: 'changed', committed: '"A"', generated: '"B"' },
        { path: 'paths./x', kind: 'removed', committed: '{}' },
      ]),
    ).toBe(true);
  });
});
