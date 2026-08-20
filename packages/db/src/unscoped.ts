/**
 * THE ONLY MODULE THAT EXPORTS AN UNSCOPED PRISMA CLIENT.
 *
 * Importing this outside migrations, seeds, the tenant client itself, and the
 * platform-admin module is a defect, and an ESLint rule fails the build for it.
 * A query made through this client has no tenant predicate and will happily
 * return every organisation's rows. See security/tenant-isolation.md §2.
 */
import { PrismaClient } from '../generated/client/index.js';

export { PrismaClient };
export type { Prisma } from '../generated/client/index.js';

export function createUnscopedPrismaClient(databaseUrl: string): PrismaClient {
  return new PrismaClient({ datasources: { db: { url: databaseUrl } } });
}
