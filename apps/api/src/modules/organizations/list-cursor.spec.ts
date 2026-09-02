import { describe, expect, it } from 'vitest';
import { cursorSchema } from '@sentinel/contracts';
import {
  CURSOR_START,
  decodeListCursor,
  encodeListCursor,
  type ListCursor,
} from './list-cursor.js';
import { DomainError } from '../../common/errors/domain-error.js';

const CURSOR: ListCursor = {
  createdAt: '2026-09-02T10:00:00.000Z',
  id: 'org_01M0T74WZZFY9T2QS56RGF3GQ7',
};

describe('encodeListCursor', () => {
  it('round-trips the sort key and the tie-breaking id', () => {
    expect(decodeListCursor(encodeListCursor(CURSOR))).toEqual(CURSOR);
  });

  it('produces something `cursorSchema` accepts', () => {
    // The contract validates a bounded, non-empty string and nothing about the
    // shape — deliberately, so the encoding can change. That freedom is only
    // real if what this produces actually satisfies the contract, which is what
    // this asserts: a cursor the endpoint issues and its own query schema then
    // rejects would be a 400 on page two and on no earlier page.
    expect(() => cursorSchema.parse(encodeListCursor(CURSOR))).not.toThrow();
  });

  it('is base64url, so it survives a query string unescaped', () => {
    // `+` and `/` from ordinary base64 are `%2B` and `%2F` in a URL, and a
    // client that forgets to encode one gets a cursor that decodes to different
    // bytes — silently, as a wrong page rather than an error. base64url has
    // neither character.
    const encoded = encodeListCursor(CURSOR);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encodeURIComponent(encoded)).toBe(encoded);
  });
});

describe('CURSOR_START', () => {
  it('is Postgres infinity, which every real timestamp compares below', () => {
    // The sentinel is what lets page one and page nine be the same SQL
    // statement — see `user-organizations.store.ts`. If this were an ordinary
    // timestamp, every row created after it would be missing from page one.
    expect(CURSOR_START.createdAt).toBe('infinity');
  });

  it('is not something `decodeListCursor` would accept from a client', () => {
    // Not a security property — a forged cursor can only move the caller's own
    // window over the caller's own rows. It is a consistency one: `infinity` is
    // not a date `new Date()` can parse, so the sentinel could never arrive
    // from the wire and be mistaken for a real position.
    expect(() => decodeListCursor(encodeListCursor(CURSOR_START))).toThrow(DomainError);
  });
});

describe('decodeListCursor refuses', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['text that is not base64url at all', '!!!not-a-cursor!!!'],
    ['base64url that is not JSON', Buffer.from('not json', 'utf8').toString('base64url')],
    ['JSON that is not an object', Buffer.from('"a string"', 'utf8').toString('base64url')],
    ['JSON null', Buffer.from('null', 'utf8').toString('base64url')],
    ['an array', Buffer.from('[]', 'utf8').toString('base64url')],
    [
      'an object missing `id`',
      Buffer.from('{"createdAt":"2026-09-02T10:00:00.000Z"}', 'utf8').toString('base64url'),
    ],
    ['an object missing `createdAt`', Buffer.from('{"id":"org_x"}', 'utf8').toString('base64url')],
    [
      '`createdAt` that is not a date',
      Buffer.from('{"createdAt":"yesterday","id":"org_x"}', 'utf8').toString('base64url'),
    ],
    [
      '`id` that is not a string',
      Buffer.from('{"createdAt":"2026-09-02T10:00:00.000Z","id":7}', 'utf8').toString('base64url'),
    ],
  ];

  it.each(cases)('%s', (_name, encoded) => {
    expect(() => decodeListCursor(encoded)).toThrow(DomainError);
  });

  it('with 400 VALIDATION_ERROR, not 500 and not a silent page one', () => {
    // **The silent page one is the failure worth naming.** Treating a bad
    // cursor as absent answers page one to a client that asked for page nine
    // and looks, to that client, exactly like reaching the start again — an
    // infinite loop in any helper that trusts `hasMore`.
    //
    // `VALIDATION_ERROR` rather than `UNKNOWN_FIELD`: the field is known and
    // its value is wrong, which is carry-forward ruling 14's split. Asserted
    // rather than described, because both codes are 400 and nothing else here
    // would tell them apart.
    let thrown: unknown;
    try {
      decodeListCursor('!!!');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DomainError);
    const error = thrown as DomainError;
    expect(error.status).toBe(400);
    expect(error.code).toBe('VALIDATION_ERROR');
  });
});
