import { z } from 'zod';

/**
 * EVERY TIMESTAMP ON THE WIRE IS A STRING, NEVER A `Date`.
 *
 * api/conventions.md §3: "Timestamps ISO 8601 with offset, always UTC
 * (`2026-08-20T14:30:00Z`)". A `Date` in a response schema is a trap — it is
 * not a JSON type, so it serialises through whatever `toJSON` the runtime
 * happens to provide, and a schema that accepts one will accept a value the API
 * can never actually send.
 *
 * WHY UTC-ONLY, i.e. `.datetime()` rather than `.datetime({ offset: true })`:
 * `{ offset: true }` enforces the "with offset" half of §3 and abandons the
 * "always UTC" half, because it also admits `2026-08-20T15:30:00+01:00`. These
 * are RESPONSE schemas — they describe what this API emits, not what it
 * tolerates from a caller — and apps/api/src/openapi/generate.integration.spec.ts
 * parses live response bodies with the contract schema. A schema that accepted
 * `+01:00` would therefore let a non-UTC response ship straight past the test
 * that exists to catch exactly that.
 *
 * Narrowing IS the breaking direction, which is precisely why it happens now:
 * nothing emits a timestamp yet, no endpoint is published, and `check:openapi`
 * has pinned nothing. Widening later, should a real need appear, is additive
 * and free.
 *
 * Declared once here rather than inline in each resource file: three copies of
 * one format is three places for the next person to change two of.
 */
export const isoTimestampSchema = z.string().datetime();
