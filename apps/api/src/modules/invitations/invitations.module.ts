import { Module } from '@nestjs/common';
import { PrismaModule } from '../../infrastructure/prisma/prisma.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { MailModule } from '../../infrastructure/mail/mail.module.js';
import { PRISMA } from '../../infrastructure/tokens.js';
import { InvitationAcceptanceController } from './invitation-acceptance.controller.js';
import { InvitationMailerAdapter } from './invitation.mailer.js';
import {
  invitationOrganizationLookup,
  type InvitationOrganizationLookup,
  type TenantTransactionBase,
} from './invitation-organization.store.js';
import { InvitationService } from './invitation.service.js';
import { InvitationsController } from './invitations.controller.js';
import {
  INVITATION_MAILER,
  INVITATION_ORGANIZATION_LOOKUP,
  type InvitationMailer,
} from './invitations.tokens.js';

/**
 * The invitation endpoints.
 *
 * `PrismaModule` and `AuditModule` are imported because neither is global:
 * `InvitationService` opens tenant transactions on the base client and
 * `AuditService` writes into them, holding no client of its own — which is what
 * `security/audit.md` §2 requires, because a service with its own client is a
 * service that can write an event for a change that then rolls back.
 *
 * # `AuthModule` is imported for two things, and only one of them leaves it whole
 *
 * `TokenService` is injected directly, for `ttlSecondsFor('INVITATION')` and
 * `expiresAtFor('INVITATION')`. That is the narrow half of it: those two methods
 * are pure functions of configuration, and `SECRET_TOKEN_KINDS` already names
 * `INVITATION` as a kind this service is expected to read (`token.service.ts`
 * says so in as many words). Nothing here calls `issue` or `consume`, which
 * write `VerificationToken` rows an invitation must never have — the invitee may
 * have no `User` at all, and that FK is required.
 *
 * `AuthMailer` is **not** reached at all, and could not be: `AuthModule`
 * deliberately does not export it, on the recorded reasoning that a consumer
 * holding the whole mailer could send a password-reset link or an
 * MFA-disabled notice to any address it liked. `InvitationMailerAdapter` in
 * this module renders the shared `EMAIL_TEMPLATES.invitation` instead, and the
 * factory below narrows even that to `INVITATION_MAILER` — a port with a
 * single function — on the discipline `memberships.module.ts` applies to
 * `SessionService`. `MailModule` is imported for `MAILER`, which is not global.
 *
 * # Two controllers, one service
 *
 * `InvitationsController` holds the three tenant-scoped routes under
 * `organizations/:id/invitations`; `InvitationAcceptanceController` holds
 * `POST /invitations/accept` alone, because that route is tenant-less and
 * permission-less by construction (D1) and cannot be mounted under a path that
 * names an organisation the caller is not yet a member of. Both reach the same
 * service, so acceptance and revocation cannot come to disagree about what
 * "live" means.
 *
 * **`InvitationService` is deliberately NOT exported**, on the rule
 * `OrganizationService` and `MembershipService` follow: a consumer elsewhere
 * holding it could invite somebody without going through the route that carries
 * the access declaration, the verified-email gate, the CSRF guard, the rate
 * limit and the audit row.
 */
@Module({
  imports: [PrismaModule, AuditModule, AuthModule, MailModule],
  controllers: [InvitationsController, InvitationAcceptanceController],
  providers: [
    InvitationMailerAdapter,
    {
      provide: INVITATION_MAILER,
      inject: [InvitationMailerAdapter],
      useFactory: (mailer: InvitationMailerAdapter): InvitationMailer => {
        return (input) => mailer.send(input);
      },
    },
    {
      // A NARROW PORT OVER THE ONE QUERY IN THIS MODULE THAT BYPASSES RLS.
      //
      // The same discipline `organizations.module.ts` applies to
      // `USER_ORGANIZATION_LOOKUP`, and it matters here for the same reason:
      // the query behind this token runs against a `SECURITY DEFINER` function
      // owned by a `BYPASSRLS` role (ADR-0022). `InvitationService` receives a
      // function taking a token hash and returning an organisation id, so the
      // widest thing it can do with the bypass is ask that one question.
      provide: INVITATION_ORGANIZATION_LOOKUP,
      inject: [PRISMA],
      useFactory: (prisma: TenantTransactionBase): InvitationOrganizationLookup =>
        invitationOrganizationLookup(prisma),
    },
    InvitationService,
  ],
})
export class InvitationsModule {}
