import { Module } from '@nestjs/common';
import type { ApiEnv } from '@sentinel/config';
import type { Logger } from '@sentinel/observability';
import { ENV, LOGGER, MAILER } from '../tokens.js';
import type { Mailer } from './mailer.port.js';
import { SmtpMailer } from './smtp-mailer.js';

/**
 * Provides the `Mailer` port, and nothing else.
 *
 * **This module has no controller and registers no route, deliberately** — the
 * same property `AuthModule` records for the same reason. Task 5 builds six
 * templates and a transport for the endpoint tasks that follow: registration
 * (Task 8), password reset (Task 10), MFA notices (Task 11) and invitations
 * (Task 15). `pnpm check:openapi` still reports four routes with this module
 * registered, and that is the check that holds it.
 *
 * Not `@Global()`. `ConfigModule` is the only global module in this codebase,
 * and a module that must be imported to be used is a module whose consumers are
 * visible in a grep — which for the component that can email arbitrary
 * addresses is worth the two lines it costs.
 *
 * The factory reads `ENV` rather than `process.env`: configuration is injected,
 * so `SmtpMailer` is constructible in a spec, in a worker, and in whatever
 * Phase 4 does with a queue, without any of them going near a global.
 *
 * Nothing here opens a connection. `SmtpMailer`'s constructor builds a
 * nodemailer transport, which connects lazily on its first `sendMail`; ruling
 * 49 forbids a `verify()` at boot, and `mail.module.spec.ts` proves the point
 * by initialising this module against a port nothing is listening on.
 */
@Module({
  providers: [
    {
      provide: MAILER,
      inject: [ENV, LOGGER],
      useFactory: (env: ApiEnv, logger: Logger): Mailer =>
        new SmtpMailer(
          {
            host: env.MAIL_HOST,
            port: env.MAIL_PORT,
            from: env.MAIL_FROM,
            secure: env.MAIL_SECURE,
            username: env.MAIL_USERNAME,
            password: env.MAIL_PASSWORD,
          },
          logger,
        ),
    },
  ],
  exports: [MAILER],
})
export class MailModule {}
