export { ID_PREFIXES, newId, parseIdPrefix } from './id.js';
export type { IdPrefix } from './id.js';
export { MissingTenantContextError } from './errors.js';
export { createTenantClient } from './tenant-client.js';
export type { TenantPrismaClient } from './tenant-client.js';
export type { TenantContext } from './tenant-context.js';
export { withTenantTransaction } from './tenant-transaction.js';
export { isTenantOwnedModel, TENANT_OWNED_MODELS } from './tenant-resources.js';
export type { TenantOwnedModel } from './tenant-resources.js';
export { isTenantRootModel, TENANT_ROOT_MODEL } from './tenant-resources.js';
export type { TenantRootModel } from './tenant-resources.js';
export {
  DELIBERATELY_GLOBAL_MODEL_NAMES,
  DELIBERATELY_GLOBAL_MODELS,
  isDeliberatelyGlobalModel,
} from './tenant-resources.js';
export type { DeliberatelyGlobalModel } from './tenant-resources.js';
// `datamodelEnums` is exported for the same reason `datamodelModels` is: a
// consumer restating a Prisma enum needs something that reads `schema.prisma`
// to notice when the restatement stops matching (ruling 13). Task 4's TTL
// completeness spec in `apps/api` is the first such consumer outside this
// package. Nothing here can open a connection — see `datamodel.ts`'s docblock.
export {
  datamodelEnums,
  datamodelModels,
  PRISMA_CLIENT_VERSION,
  schemaStaleness,
} from './datamodel.js';
export type { DatamodelEnum, DatamodelModel, DatamodelRelation } from './datamodel.js';
export { computeSchemaHash, decideSchemaStaleness, normaliseSchema } from './schema-hash.js';
export type { SchemaStaleness } from './schema-hash.js';
