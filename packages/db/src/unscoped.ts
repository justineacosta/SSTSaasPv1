/**
 * THE ONLY MODULE THAT EXPORTS AN UNSCOPED PRISMA CLIENT.
 *
 * Importing this outside migrations, seeds, the tenant client itself, and the
 * platform-admin module is a defect, and an ESLint rule fails the build for it.
 * A query made through this client has no tenant predicate and will happily
 * return every organisation's rows. See security/tenant-isolation.md §2.
 */
import { PrismaClient, Prisma } from '../generated/client/index.js';

// `Prisma` is exported as a value, not type-only: the integration tests need
// `Prisma.PrismaClientKnownRequestError` at runtime (`instanceof` and shape
// assertions on the error findUniqueOrThrow raises for a cross-tenant miss —
// see tenant-client.integration.spec.ts and tenant-transaction.integration.spec.ts).
// tenant-client.ts itself only needs `Prisma`'s types, via the `type PrismaClient`
// import above; production code does not construct this error directly — it
// re-runs the query so Prisma's own engine raises it (see that file's
// `notFoundIsThrow` comment for why).
export { PrismaClient, Prisma };

export function createUnscopedPrismaClient(databaseUrl: string): PrismaClient {
  return new PrismaClient({ datasources: { db: { url: databaseUrl } } });
}
