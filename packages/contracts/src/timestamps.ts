import { z } from 'zod';

/**
 * EVERY TIMESTAMP ON THE WIRE IS A STRING, NEVER A `Date`.
 *
 * api/conventions.md §3: ISO 8601 with an offset, always UTC
 * (`2026-08-20T14:30:00Z`). A `Date` in a response schema is a trap — it is not
 * a JSON type, so it serialises through whatever `toJSON` the runtime happens
 * to provide, and a schema that accepts one will accept a value the API can
 * never actually send.
 *
 * `{ offset: true }` also accepts an explicit non-UTC offset such as
 * `+01:00`. What it refuses is a bare local time like `2026-08-20T14:30:00`,
 * which is ambiguous by an hour twice a year and by the reader's guess about
 * the server's timezone the rest of the time.
 *
 * Declared once here rather than inline in each resource file: three copies of
 * one format is three places for the next person to change two of.
 */
export const isoTimestampSchema = z.string().datetime({ offset: true });
