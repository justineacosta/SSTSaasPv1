/**
 * SCHEMA PROVENANCE — does the generated Prisma client actually describe
 * `schema.prisma` as it exists on disk right now?
 *
 * `pnpm check:registry` answers every one of its questions from the generated
 * DMMF. Nothing otherwise ties that artefact to the schema file: edit the schema
 * without regenerating and the check reports on a model nobody has any more. A
 * review proved it by reintroducing Task 6's live `Membership.userId` cascade
 * defect without regenerating and watching the check print `OK`, exit 0. A check
 * whose whole premise is refusing to answer from an unverified artefact cannot
 * itself answer from one.
 *
 * WHAT IS COMPARED, AND WHY THIS FORM. `prisma generate` writes its own copy of
 * the schema to `generated/client/schema.prisma`, in the same invocation that
 * writes the DMMF and into the same directory. That copy therefore *cannot*
 * drift from the DMMF — anything that restores, deletes or refreshes one does
 * the same to the other.
 *
 * The first attempt recorded a hash of `schema.prisma` at generate time instead.
 * That was the reviewer's suggested form, and it has a defect found by
 * measurement: `@sentinel/db`'s build is a cached turbo task, so a cache hit
 * replays its logs without re-running the recorder, and the hash file was simply
 * never written. `pnpm build && pnpm check:registry` then failed for a reason
 * that had nothing to do with the schema. Comparing against an artefact Prisma
 * itself writes has no such coupling: there is no separate step to skip.
 *
 * NORMALISATION. Prisma's copy is *reformatted* — measured: field names are
 * column-aligned, so it is never byte-equal to the source. Runs of horizontal
 * whitespace are collapsed and blank lines dropped before hashing, which makes
 * the two match exactly today while still detecting a real change: verified that
 * flipping `onDelete: Restrict` to `Cascade` is still caught.
 *
 * This does assume Prisma's formatter only ever differs from the source by
 * horizontal whitespace. If a future Prisma reorders or rewrites anything, this
 * reports stale — the red direction, with an instruction that resolves it.
 */
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

/**
 * Both paths resolve identically from `src/` (vitest, tsx) and from `dist/`
 * (compiled), because each is one directory below `packages/db`.
 */
export const SCHEMA_PATH = fileURLToPath(new URL('../prisma/schema.prisma', import.meta.url));
export const GENERATED_SCHEMA_PATH = fileURLToPath(
  new URL('../generated/client/schema.prisma', import.meta.url),
);

/**
 * Collapses the differences that are pure presentation.
 *
 * Line endings, because a working tree can hold CRLF while git stores LF, and a
 * guard that cries wolf over that is a guard people route around. Horizontal
 * whitespace and blank lines, because that is precisely and only what Prisma's
 * formatter changes.
 */
export function normaliseSchema(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

/** sha256 of the normalised schema text. Pure. */
export function computeSchemaHash(text: string): string {
  return createHash('sha256').update(normaliseSchema(text), 'utf8').digest('hex');
}

/** Why the generated client cannot be trusted, or `undefined` when it can. */
export type SchemaStaleness = 'no-source-schema' | 'no-generated-schema' | 'schema-mismatch';

/**
 * The decision, as a pure function so both directions are unit-testable without
 * touching the filesystem.
 *
 * Every ambiguous case resolves to stale. An absent generated copy means the
 * client's provenance is simply unknown — and "unknown" has to read as "stale",
 * because the alternative is the false green this exists to stop.
 */
export function decideSchemaStaleness(
  generated: string | undefined,
  source: string | undefined,
): SchemaStaleness | undefined {
  if (source === undefined) return 'no-source-schema';
  if (generated === undefined) return 'no-generated-schema';
  return computeSchemaHash(generated) === computeSchemaHash(source) ? undefined : 'schema-mismatch';
}
