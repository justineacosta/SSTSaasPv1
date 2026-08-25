import { z } from 'zod';

/**
 * pagination.md §4. Default 50, maximum 100 for ordinary endpoints.
 *
 * Declared before `paginationSchema` rather than beside `listQuerySchema`
 * because both the request limit and the echoed response limit are bounded by
 * `LIST_LIMIT_MAX`, and a `const` referenced by a schema built above it is a
 * temporal-dead-zone crash at import time, not a type error.
 */
export const LIST_LIMIT_DEFAULT = 50;
export const LIST_LIMIT_MAX = 100;

/**
 * THE RESPONSE ENVELOPE'S PAGINATION BLOCK — pagination.md §1.
 *
 * `limit` is the APPLIED limit, and it is required rather than optional. §4
 * says a limit above the maximum is clamped rather than rejected, so a client
 * asking for 500 gets 100 rows back; with no echo it cannot tell that apart
 * from "100 is all there was" and stops paginating, having silently seen a
 * fraction of what it asked for. Optional would be worse than absent: half the
 * endpoints would omit it and clients would have to guess anyway.
 *
 * Bounded by `LIST_LIMIT_MAX` for the same reason the query is: an echo that
 * can report 500 lets a handler claim a limit it did not apply.
 */
export const paginationSchema = z.object({
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
  limit: z.number().int().min(1).max(LIST_LIMIT_MAX),
});

export const collectionMetaSchema = z.object({ total: z.number().int().nonnegative() });

/** Every list endpoint returns this shape. See api/conventions.md §4. */
export function collectionEnvelopeSchema<TItem extends z.ZodTypeAny>(item: TItem) {
  return z.object({
    data: z.array(item),
    pagination: paginationSchema,
    meta: collectionMetaSchema.optional(),
  });
}

export type Pagination = z.infer<typeof paginationSchema>;

/**
 * The cursor is an opaque base64 encoding of the sort key and the tie-breaking
 * ID (pagination.md §1). Its encoding is deliberately NOT part of the contract,
 * so the only thing validated here is that it is a bounded, non-empty string —
 * validating its structure would make the encoding a promise we would then have
 * to keep. The upper bound exists because an unvalidated string field is free
 * memory for a caller; 512 is far above any cursor this scheme produces.
 */
export const cursorSchema = z.string().min(1).max(512);

/**
 * THE BASE QUERY FOR EVERY LIST ENDPOINT.
 *
 * "Every list endpoint paginates. There are no unbounded list endpoints" is a
 * core rule, not a later refinement, and the way it is lost is an endpoint
 * shipping with an optional `limit` that means "all rows" when absent. A
 * default on the schema means the unbounded query cannot be expressed.
 *
 * `z.coerce` because these arrive as query-string text, never as JSON numbers.
 *
 * The limit is CLAMPED above the maximum rather than rejected, per
 * pagination.md §4: a client asking for 500 wants as many as it can have, and
 * a 400 there is a worse answer than 100 rows. The clamped value is what a
 * handler must report in `paginationSchema.limit` — the clamp and the echo are
 * one feature, and shipping the clamp without the echo is what makes silent
 * truncation invisible to the caller.
 *
 * `.strict()`, like every request schema here: a misspelled filter that is
 * silently ignored returns the wrong rows and looks like a server bug.
 * Resource-specific queries extend this with `.extend()`, which preserves the
 * strictness.
 */
export const listQuerySchema = z
  .object({
    cursor: cursorSchema.optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .transform((value) => Math.min(value, LIST_LIMIT_MAX))
      .default(LIST_LIMIT_DEFAULT),
  })
  .strict();

export type ListQuery = z.infer<typeof listQuerySchema>;
