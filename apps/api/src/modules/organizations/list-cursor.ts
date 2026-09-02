import { ERROR_CODES } from '@sentinel/contracts';
import { DomainError } from '../../common/errors/domain-error.js';

/**
 * THE KEYSET CURSOR FOR `GET /api/v1/organizations`.
 *
 * `api/pagination.md` §1: "an opaque base64 encoding of the sort key and the
 * tie-breaking ID", and clients "must treat it as opaque; the encoding is not
 * part of the contract and will change". `cursorSchema` in
 * `@sentinel/contracts` validates exactly that much and no more — a bounded,
 * non-empty string — so everything about the shape lives here.
 *
 * **The ID tie-breaker is not optional**, in §1's own words. Sorting on
 * `createdAt` alone silently skips or repeats rows whenever two organisations
 * share a timestamp, which for rows written in the same transaction is common
 * rather than rare.
 *
 * # It is not signed, and it does not need to be
 *
 * A forged cursor can only move the caller's own window over the caller's own
 * organisations: the predicate that decides *which* rows exist is fixed inside
 * `user_organizations(text)` and takes the user id from the session (ADR-0020).
 * There is no value a caller could put here that widens the set. Signing it
 * would add a key to provision and rotate in exchange for nothing.
 */
export interface ListCursor {
  /** The `createdAt` of the last row on the previous page, as an ISO string. */
  readonly createdAt: string;
  /** That row's id, which breaks ties within one timestamp. */
  readonly id: string;
}

/**
 * The sentinel that means "start at the beginning".
 *
 * Postgres's `timestamptz` has a literal `infinity` that compares greater than
 * every real timestamp, so `("createdAt", id) < ('infinity', '')` is true for
 * every row. That lets the first page and every later page use **one** SQL
 * statement with one predicate, rather than two statements differing by a
 * `WHERE` clause — and a branch in SQL is a branch only integration tests can
 * reach.
 */
export const CURSOR_START: ListCursor = { createdAt: 'infinity', id: '' };

export function encodeListCursor(cursor: ListCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/**
 * Decodes a client-supplied cursor, or refuses it.
 *
 * **A malformed cursor is a 400, not a silently ignored parameter.** Treating
 * it as absent would answer page one to a client that asked for page nine and
 * looked, to that client, exactly like reaching the start of the list again —
 * an infinite loop in any pagination helper that trusts `hasMore`.
 * `VALIDATION_ERROR` rather than `UNKNOWN_FIELD`: the field is known and its
 * value is wrong, which is carry-forward ruling 14's split.
 *
 * The `createdAt` is validated by round-tripping it through `Date`, not by a
 * regular expression: what has to be true is that Postgres can compare it as a
 * `timestamptz`, and an ISO string that `Date` refuses is one Postgres would
 * refuse too — with a 500 rather than a 400, from inside the query.
 */
export function decodeListCursor(encoded: string): ListCursor {
  const refuse = (): never => {
    throw new DomainError(
      ERROR_CODES.VALIDATION_ERROR,
      'The cursor is not one this endpoint issued. Start again without a cursor.',
      400,
      { fields: { cursor: 'Malformed cursor.' } },
    );
  };

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    return refuse();
  }

  if (typeof parsed !== 'object' || parsed === null) return refuse();
  const candidate = parsed as Record<string, unknown>;
  const createdAt = candidate['createdAt'];
  const id = candidate['id'];
  if (typeof createdAt !== 'string' || typeof id !== 'string') return refuse();
  if (Number.isNaN(new Date(createdAt).getTime())) return refuse();

  return { createdAt, id };
}
