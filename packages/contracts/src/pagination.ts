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
