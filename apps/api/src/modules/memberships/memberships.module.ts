import { Module } from '@nestjs/common';
import { PrismaModule } from '../../infrastructure/prisma/prisma.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { SessionService } from '../auth/session.service.js';
import { MembershipService } from './membership.service.js';
import { MembershipsController } from './memberships.controller.js';
import { MEMBER_SESSION_REVOKER, type MemberSessionRevoker } from './memberships.tokens.js';

/**
 * The three membership endpoints.
 *
 * `PrismaModule` and `AuditModule` are imported because neither is global:
 * `MembershipService` opens tenant transactions on the base client, and
 * `AuditService` writes into them, holding no client of its own — which is what
 * `security/audit.md` §2 requires, because a service with its own client is a
 * service that can write an event for a change that then rolls back.
 *
 * # `AuthModule` is imported for one method, and only one method leaves it
 *
 * This is the first module outside `AuthModule` itself to consume
 * `SessionService`, which that module has exported since Task 6 with nothing
 * consuming it. It is not injected directly: the factory below closes over it
 * and provides `MEMBER_SESSION_REVOKER`, a port with a single function. The
 * discipline is `organizations.module.ts`'s — a consumer holding the whole
 * service could mint a session, rotate one, or revoke every session a user has
 * anywhere — and here it is sharper than usual, because `revokeAllForUser` and
 * `revokeAllForUserInOrganization` differ by one argument and by whether a
 * consultant removed from one organisation stays signed in to the other three
 * (carry-forward ruling 95).
 *
 * **`MembershipService` is deliberately NOT exported**, on the same rule
 * `OrganizationService` follows: a consumer elsewhere holding it could change a
 * role or remove a member without going through the route that carries the
 * access declaration, the CSRF guard and the audit row.
 */
@Module({
  imports: [PrismaModule, AuditModule, AuthModule],
  controllers: [MembershipsController],
  providers: [
    {
      provide: MEMBER_SESSION_REVOKER,
      inject: [SessionService],
      useFactory: (sessions: SessionService): MemberSessionRevoker => {
        return (userId, organizationId) =>
          sessions.revokeAllForUserInOrganization(userId, organizationId);
      },
    },
    MembershipService,
  ],
})
export class MembershipsModule {}
