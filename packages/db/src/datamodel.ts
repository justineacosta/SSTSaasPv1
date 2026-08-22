/**
 * READ-ONLY DATAMODEL METADATA — the shape of the schema, never a connection.
 *
 * `pnpm check:registry` has to answer "which models carry `organizationId`, and
 * what is each foreign key's `ON DELETE`?" from the artefact that actually
 * defines it, rather than from a list someone remembered to update. Prisma
 * publishes exactly that as `Prisma.dmmf.datamodel`.
 *
 * This module exists so the check can read it **without** importing
 * `./unscoped.js`. That module exports a real `PrismaClient` and is fenced off
 * by an ESLint `no-restricted-imports` rule with a short, deliberate exemption
 * list (security/tenant-isolation.md §2, Layer 1). Widening that list so a CI
 * script can read metadata would trade a security fence for a convenience.
 * Nothing exported here can issue a query.
 *
 * Measured with Prisma 6.19.3 (`Prisma.prismaVersion.client`): when a relation
 * in `schema.prisma` omits `onDelete`, the DMMF field carries **no**
 * `relationOnDelete` key at all — Prisma does not materialise its default into
 * the DMMF. `onDelete` is therefore `undefined` for those, and the caller must
 * decide what that means rather than assume a default.
 */
import { Prisma } from '../generated/client/index.js';

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
  }));
}

/** The Prisma client version the datamodel above was read from. */
export const PRISMA_CLIENT_VERSION: string = Prisma.prismaVersion.client;
