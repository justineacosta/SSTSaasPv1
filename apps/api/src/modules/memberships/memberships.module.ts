import { Module } from '@nestjs/common';
import { PrismaModule } from '../../infrastructure/prisma/prisma.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { AuditService } from '../audit/audit.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { SessionService } from '../auth/session.service.js';
import {
  invitationRevocationCascade,
  type InvitationRevocationCascade,
} from '../invitations/invitation-revocation.cascade.js';
import { MembershipService } from './membership.service.js';
import { MembershipsController } from './memberships.controller.js';
import {
  INVITATION_REVOCATION_CASCADE,
  MEMBER_SESSION_REVOKER,
  type MemberSessionRevoker,
} from './memberships.tokens.js';

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
    {
      // ADR-0026. THE SECOND NARROW PORT, ON THE SAME RULE AS THE FIRST.
      //
      // `MembershipService` must revoke the invitations a removed or demoted
      // member issued, in the same transaction as the change — so it needs to
      // write to `Invitation`, a table the invitations module owns. It is
      // handed one function taking the transaction handle rather than
      // `InvitationService`, which could invite, list, revoke by id or accept.
      //
      // The factory imports from `invitations/` and that direction is the safe
      // one: `invitation-revocation.cascade.ts` imports nothing from
      // `memberships/`, so there is no ES module cycle. A cascade written into
      // `invitation.service.ts` instead would have made one, because that file
      // already imports `membership.service.ts` for `assertActorMayGrant`.
      provide: INVITATION_REVOCATION_CASCADE,
      inject: [AuditService],
      useFactory: (audit: AuditService): InvitationRevocationCascade =>
        invitationRevocationCascade(audit),
    },
    MembershipService,
  ],
})
export class MembershipsModule {}
