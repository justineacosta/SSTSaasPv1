import { Module } from '@nestjs/common';
import { PrismaModule } from '../../infrastructure/prisma/prisma.module.js';
import { PRISMA } from '../../infrastructure/tokens.js';
import { AuditModule } from '../audit/audit.module.js';
import { OrganizationService } from './organization.service.js';
import { OrganizationsController } from './organizations.controller.js';
import { USER_ORGANIZATION_LOOKUP } from './organizations.tokens.js';
import {
  type TenantTransactionBase,
  type UserOrganizationLookup,
  userOrganizationLookup,
} from './user-organizations.store.js';

/**
 * The five organisation endpoints, and the first module in this product whose
 * routes declare a permission.
 *
 * `PrismaModule` and `AuditModule` are imported because neither is global:
 * `OrganizationService` opens tenant transactions on the base client, and
 * `AuditService` writes into them. `AuditModule` provides that service with no
 * Prisma client of its own, which is what `security/audit.md` §2 requires — a
 * service holding its own client is a service that can write an event for a
 * change that then rolls back.
 *
 * **`OrganizationService` is deliberately NOT exported**, on the same rule
 * `AuthModule` applies to its own services: a consumer elsewhere holding it
 * could create an organisation, rename one, or attempt a deletion without going
 * through the route that carries the access declaration, the CSRF guard and the
 * audit row. Nothing outside this module needs it — `POST /auth/switch-org`
 * lives in `AuthModule` and asks a different question (does this caller hold an
 * ACTIVE membership), through its own narrow port.
 */
@Module({
  imports: [PrismaModule, AuditModule],
  controllers: [OrganizationsController],
  providers: [
    {
      // THE ONE PLACE THE BASE PRISMA CLIENT REACHES ADR-0020's LOOKUP.
      //
      // Following `ACTIVE_ORGANIZATION_LOOKUP` in `auth.module.ts`: the lookup
      // is a closure over the client, and exposing the one question rather than
      // the client means `OrganizationService` cannot reach `$queryRaw` for
      // anything else. That matters more here than there, because the query
      // behind this token is the only one in the product that crosses
      // organisation boundaries.
      provide: USER_ORGANIZATION_LOOKUP,
      inject: [PRISMA],
      useFactory: (prisma: TenantTransactionBase): UserOrganizationLookup =>
        userOrganizationLookup(prisma),
    },
    OrganizationService,
  ],
})
export class OrganizationsModule {}
