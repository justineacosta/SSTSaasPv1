/**
 * THE ONLY MODULE THAT EXPORTS AN UNSCOPED PRISMA CLIENT.
 *
 * Importing this outside migrations, seeds, the tenant client itself, and the
 * platform-admin module is a defect, and an ESLint rule fails the build for it.
 * A query made through this client has no tenant predicate and will happily
 * return every organisation's rows. See security/tenant-isolation.md §2.
 */
import { PrismaClient, Prisma } from '../generated/client/index.js';

// `Prisma` is exported as a value, not type-only: tenant-client.ts needs
// `Prisma.PrismaClientKnownRequestError` at runtime (to raise Prisma's own
// P2025 "not found" shape for a cross-tenant findUniqueOrThrow miss — see
// its file comment), not just the namespace's types.
export { PrismaClient, Prisma };

export function createUnscopedPrismaClient(databaseUrl: string): PrismaClient {
  return new PrismaClient({ datasources: { db: { url: databaseUrl } } });
}
