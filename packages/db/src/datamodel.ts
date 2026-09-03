/**
 * READ-ONLY DATAMODEL METADATA — the shape of the schema, never a connection.
 *
 * `pnpm check:registry` has to answer "which models carry `organizationId`, and
 * what is each foreign key's `ON DELETE`?" from the artefact that actually
 * defines it, rather than from a list someone remembered to update. Prisma
 * publishes exactly that as `Prisma.dmmf.datamodel`.
 *
 * This module exists so the check can read that metadata without going through
 * `./unscoped.js`, which exports a real `PrismaClient`. Nothing exported here
 * can issue a query: no `PrismaClient`, no re-export of `Prisma`, only plain
 * data describing the schema's shape.
 *
 * An earlier version of this comment justified the file by claiming it avoided
 * widening the `no-restricted-imports` fence around the unscoped client. That
 * was **false**, and a review proved it: at the time the fence matched only the
 * `unscoped` and `unscoped.js` module specifiers plus `@sentinel/db/unscoped`,
 * so the `../generated/client/index.js` import below was never covered by it
 * and nothing would have been widened. The reviewer demonstrated the hole with
 * a non-exempt probe file importing `PrismaClient` from that path directly:
 * lint exited 0. The fence has since been widened to cover the generated client
 * path too (see `eslint.config.js`), with this file and `unscoped.ts` as its
 * only exemptions — so the justification is now true, but it was written before
 * it was, and it is recorded that way on purpose.
 *
 * The real reason to keep this module is narrower and was always sound: a CI
 * script that needs the schema's shape should not be handed something that can
 * open a connection. See security/tenant-isolation.md §2, Layer 1.
 *
 * Measured with Prisma 6.19.3 (`Prisma.prismaVersion.client`): when a relation
 * in `schema.prisma` omits `onDelete`, the DMMF field carries **no**
 * `relationOnDelete` key at all — Prisma does not materialise its default into
 * the DMMF. `onDelete` is therefore `undefined` for those, and the caller must
 * decide what that means rather than assume a default.
 */
import { readFileSync } from 'node:fs';
import { Prisma } from '../generated/client/index.js';
import {
  decideSchemaStaleness,
  GENERATED_SCHEMA_PATH,
  SCHEMA_PATH,
  type SchemaStaleness,
} from './schema-hash.js';

/** One foreign key, as seen from the child model that owns the column. */
export interface DatamodelRelation {
  /** The relation field's name on the child model, e.g. `user`. */
  readonly field: string;
  /** The model the foreign key points at — the parent, the one a delete starts from. */
  readonly parentModel: string;
  /**
   * The declared referential action, or `undefined` when the schema omits it.
   * See the file docblock: absent means "not written down", not "default".
   */
  readonly onDelete: string | undefined;
}

/** One model, reduced to what the registry checks need. */
export interface DatamodelModel {
  readonly name: string;
  /** Every field name on the model, scalar and relation alike. */
  readonly fields: readonly string[];
  /** Only the relations whose foreign key column lives on *this* model. */
  readonly relations: readonly DatamodelRelation[];
  /**
   * The names of every multi-column `@@unique` on this model, each as its
   * component field names in declaration order.
   *
   * Single-column uniques (`@unique` on a field) are excluded: they generate a
   * flat `where` input and are not what the caller of this field is asking
   * about. A **compound** unique is, because Prisma generates a *nested*
   * `where` input for it — `{ organizationId_email: { organizationId, email } }`
   * — and that nested shape is the one the tenant client's design is built
   * around never rewriting.
   *
   * Added in Phase 2 Task 15 for a sentinel rather than for a check: when the
   * `Invitation` compound unique became partial, **no tenant-owned model had a
   * compound unique left**, and the integration test that proved the nested
   * shape survived the extension lost its subject. See
   * `tenant-client.integration.spec.ts`.
   */
  readonly compoundUniques: readonly (readonly string[])[];
}

/**
 * The Prisma datamodel, flattened.
 *
 * A relation appears on both sides in the DMMF; only the side carrying
 * `relationFromFields` owns the constraint, so the other side is dropped. That
 * is what makes `parentModel` unambiguous: the delete cascades *from*
 * `parentModel` *into* the model this relation is listed under.
 */
export function datamodelModels(): readonly DatamodelModel[] {
  return Prisma.dmmf.datamodel.models.map((model) => ({
    name: model.name,
    fields: model.fields.map((field) => field.name),
    relations: model.fields
      .filter(
        (field) => field.relationFromFields !== undefined && field.relationFromFields.length > 0,
      )
      .map((field) => ({
        field: field.name,
        parentModel: field.type,
        onDelete: field.relationOnDelete,
      })),
    // `uniqueIndexes` carries only the model-level `@@unique` declarations;
    // a field-level `@unique` does not appear there. The length filter is
    // belt-and-braces for a one-column `@@unique([x])`, which is legal Prisma
    // and generates a flat input like a field-level one.
    compoundUniques: model.uniqueIndexes
      .map((index) => [...index.fields])
      .filter((fields) => fields.length > 1),
  }));
}

/** One enum declared in `schema.prisma`, reduced to its name and values. */
export interface DatamodelEnum {
  readonly name: string;
  /** Value names in declaration order. `dbName` is dropped: nothing maps one. */
  readonly values: readonly string[];
}

/**
 * The schema's enums, flattened.
 *
 * Exists so `enum-parity.spec.ts` can compare `schema.prisma`'s enums against
 * the constants `@sentinel/contracts` restates for the wire. That comparison
 * has to read the schema itself — a spec comparing a contracts constant to a
 * literal typed out beside it proves only that two lines of the same file
 * agree, and stays green through any change made on the database side.
 *
 * Returned as plain strings rather than the DMMF's `{ name, dbName }` objects
 * for the same reason the rest of this module flattens: a caller that has to
 * know the DMMF's shape is a caller coupled to a Prisma internal.
 */
export function datamodelEnums(): readonly DatamodelEnum[] {
  return Prisma.dmmf.datamodel.enums.map((declared) => ({
    name: declared.name,
    values: declared.values.map((value) => value.name),
  }));
}

/** The Prisma client version the datamodel above was read from. */
export const PRISMA_CLIENT_VERSION: string = Prisma.prismaVersion.client;

/**
 * Whether the generated DMMF above can be trusted to describe `schema.prisma`
 * as it exists on disk right now, or `undefined` when it can.
 *
 * Every caller of `datamodelModels()` that is making a security decision must
 * consult this first. `Prisma.prismaVersion.client` answers a different and much
 * weaker question — which client library is installed — and reads like a
 * provenance claim while saying nothing at all about whether the model matches
 * the schema.
 *
 * Fails closed: an unreadable schema or an unreadable hash file is reported as
 * stale rather than swallowed.
 */
export function schemaStaleness(): SchemaStaleness | undefined {
  const read = (path: string): string | undefined => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return undefined;
    }
  };

  return decideSchemaStaleness(read(GENERATED_SCHEMA_PATH), read(SCHEMA_PATH));
}
