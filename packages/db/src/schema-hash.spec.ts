import { describe, expect, it } from 'vitest';
import { computeSchemaHash, decideSchemaStaleness, normaliseSchema } from './schema-hash.js';

const SOURCE = `model Membership {
  id             String @id
  organizationId String

  user User @relation(fields: [userId], references: [id], onDelete: Restrict)
}
`;

/** How Prisma actually writes its own copy: column-aligned, blank lines kept. */
const PRISMA_FORMATTED = `model Membership {
  id             String @id
  organizationId String

  user         User         @relation(fields: [userId], references: [id], onDelete: Restrict)
}
`;

describe('normaliseSchema', () => {
  it('collapses exactly what Prisma reformats and nothing else', () => {
    expect(normaliseSchema(PRISMA_FORMATTED)).toBe(normaliseSchema(SOURCE));
  });

  it('drops blank lines and trims', () => {
    expect(normaliseSchema('a\n\n   b   \n')).toBe('a\nb');
  });

  it('does not merge separate lines', () => {
    expect(normaliseSchema('a\nb')).toBe('a\nb');
    expect(normaliseSchema('a b')).not.toBe('a\nb');
  });
});

describe('computeSchemaHash', () => {
  it('is stable for identical content', () => {
    expect(computeSchemaHash(SOURCE)).toBe(computeSchemaHash(SOURCE));
  });

  it('ignores line endings', () => {
    // A working tree can hold CRLF while git stores LF. A guard that cried wolf
    // over that is a guard people route around.
    expect(computeSchemaHash('model A {\r\n}\r\n')).toBe(computeSchemaHash('model A {\n}\n'));
  });

  it('changes when a referential action changes', () => {
    expect(computeSchemaHash('onDelete: Restrict')).not.toBe(
      computeSchemaHash('onDelete: Cascade'),
    );
  });
});

describe('decideSchemaStaleness', () => {
  it('accepts Prisma’s reformatted copy of the same schema', () => {
    // The whole mechanism rests on this: the generated copy is never
    // byte-equal to the source, only semantically equal.
    expect(decideSchemaStaleness(PRISMA_FORMATTED, SOURCE)).toBeUndefined();
  });

  it('reports a mismatch when the schema moved since generate', () => {
    // The exact scenario a review reproduced: Membership.userId put back to
    // onDelete: Cascade without regenerating, and check:registry printed OK.
    const edited = SOURCE.replace('onDelete: Restrict', 'onDelete: Cascade');
    expect(decideSchemaStaleness(PRISMA_FORMATTED, edited)).toBe('schema-mismatch');
  });

  it('treats a missing generated copy as stale, not as fine', () => {
    // Unknown provenance has to read as stale. The alternative is the false
    // green this guard exists to stop.
    expect(decideSchemaStaleness(undefined, SOURCE)).toBe('no-generated-schema');
  });

  it('reports an unreadable source schema rather than passing', () => {
    expect(decideSchemaStaleness(PRISMA_FORMATTED, undefined)).toBe('no-source-schema');
  });

  it('checks the source before the generated copy when both are missing', () => {
    expect(decideSchemaStaleness(undefined, undefined)).toBe('no-source-schema');
  });
});
