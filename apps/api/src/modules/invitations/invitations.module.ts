import { Module } from '@nestjs/common';
import { PrismaModule } from '../../infrastructure/prisma/prisma.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { MailModule } from '../../infrastructure/mail/mail.module.js';
import { InvitationMailerAdapter } from './invitation.mailer.js';
import { InvitationService } from './invitation.service.js';
import { InvitationsController } from './invitations.controller.js';
import { INVITATION_MAILER, type InvitationMailer } from './invitations.tokens.js';

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
 * **`InvitationService` is deliberately NOT exported**, on the rule
 * `OrganizationService` and `MembershipService` follow: a consumer elsewhere
 * holding it could invite somebody without going through the route that carries
 * the access declaration, the verified-email gate, the CSRF guard, the rate
 * limit and the audit row.
 */
@Module({
  imports: [PrismaModule, AuditModule, AuthModule, MailModule],
  controllers: [InvitationsController],
  providers: [
    InvitationMailerAdapter,
    {
      provide: INVITATION_MAILER,
      inject: [InvitationMailerAdapter],
      useFactory: (mailer: InvitationMailerAdapter): InvitationMailer => {
        return (input) => mailer.send(input);
      },
    },
    InvitationService,
  ],
})
export class InvitationsModule {}
