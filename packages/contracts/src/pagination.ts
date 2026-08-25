import { z } from 'zod';

export const paginationSchema = z.object({
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
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

/** pagination.md §4. Default 50, maximum 100 for ordinary endpoints. */
export const LIST_LIMIT_DEFAULT = 50;
export const LIST_LIMIT_MAX = 100;

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
 * a 400 there is a worse answer than 100 rows. Note that the applied limit is
 * not yet echoed back — `paginationSchema` above carries `nextCursor` and
 * `hasMore` only, so a client cannot currently see that its 500 became 100.
 * Closing that means adding a field to a response shape, which is the task that
 * ships the first real list endpoint, not this one.
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
