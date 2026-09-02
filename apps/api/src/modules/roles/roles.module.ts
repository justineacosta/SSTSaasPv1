import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '../../infrastructure/prisma/prisma.module.js';
import { PRISMA } from '../../infrastructure/tokens.js';
import { MFA_ENROLMENT_POLICY } from '../auth/auth.tokens.js';
import { TENANT_RESOLVER } from './roles.tokens.js';
import {
  mfaEnrolmentPolicy,
  tenantResolver,
  type TenantTransactionBase,
} from './tenant-resolver.store.js';

/**
 * The tenant-resolution half of `security/authorization.md` §2.
 *
 * # `@Global()`, and the reason is the guards
 *
 * `TenantContextGuard` and `MfaEnrolmentGuard` are registered as `APP_GUARD`
 * providers in `AppModule`, which is where a global guard has to be registered
 * for it to be global. Nest resolves an `APP_GUARD`'s dependencies from the
 * module that declares it, so both tokens have to be visible there — and
 * `AppModule` importing a module purely so that two guards can be constructed
 * is the same thing this achieves without the import order mattering.
 *
 * `MFA_ENROLMENT_POLICY` is declared in `auth.tokens.ts` and provided here
 * rather than in `AuthModule`, deliberately. Task 11 wrote that token's
 * docblock as "**NOTHING PROVIDES THIS TOKEN** ... the query behind this port
 * needs organisation membership under tenant scoping, which is Task 12's". The
 * query lives with the other tenant-scoped query, in one file, so there is one
 * place where the base Prisma client is turned into a tenant transaction.
 *
 * # Both providers take the base client and neither exposes it
 *
 * `PRISMA` is the unscoped client. It reaches exactly two factories here, each
 * of which closes over it and returns a function answering one question. No
 * guard, controller or service in this application receives the base client
 * from this module — the same discipline `ACTIVE_ORGANIZATION_LOOKUP` follows
 * in `AuthModule`.
 */
@Global()
@Module({
  // `PrismaModule` is not global, so `PRISMA` has to be imported to be
  // injectable here — the same import `AuthModule` makes. `@Global()` on this
  // module governs what it EXPORTS, not what it can see.
  imports: [PrismaModule],
  providers: [
    {
      provide: TENANT_RESOLVER,
      inject: [PRISMA],
      useFactory: (prisma: TenantTransactionBase) => tenantResolver(prisma),
    },
    {
      provide: MFA_ENROLMENT_POLICY,
      inject: [PRISMA],
      useFactory: (prisma: TenantTransactionBase) => mfaEnrolmentPolicy(prisma),
    },
  ],
  exports: [TENANT_RESOLVER, MFA_ENROLMENT_POLICY],
})
export class RolesModule {}
