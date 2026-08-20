import { z } from 'zod';
import { ERROR_CODE_VALUES } from './error-codes.js';

/**
 * A per-field validation error. `path` uses dotted/bracketed notation matching
 * the request body (`targets[0]`, `scope.rules[2].value`) so a client can map
 * the error onto its input without guessing. See api/errors.md §2.
 */
export const fieldErrorSchema = z.object({
  path: z.string(),
  code: z.string(),
  message: z.string(),
});

export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: z.enum(ERROR_CODE_VALUES),
    message: z.string(),
    details: z.record(z.unknown()).optional(),
    requestId: z.string(),
    documentation: z.string().url().optional(),
  }),
});

export type FieldError = z.infer<typeof fieldErrorSchema>;
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;
