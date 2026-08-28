import { Body, Controller, HttpCode, Inject, Post, Req } from '@nestjs/common';
import {
  type RegisterRequest,
  type RegisterResponse,
  registerRequestSchema,
  registerResponseSchema,
  type ResendVerificationRequest,
  type ResendVerificationResponse,
  resendVerificationRequestSchema,
  resendVerificationResponseSchema,
  type VerifyEmailRequest,
  type VerifyEmailResponse,
  verifyEmailRequestSchema,
  verifyEmailResponseSchema,
} from '@sentinel/contracts';
import type { Request } from 'express';
import { Public } from '../../common/decorators/access.decorator.js';
import { ApiDoc } from '../../common/decorators/openapi.decorator.js';
import { RateLimit } from '../../common/decorators/rate-limit.decorator.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { EmailVerificationService } from './email-verification.service.js';
import { RegistrationService } from './registration.service.js';
import { requestContextOf } from './request-context.js';

/**
 * THE FIRST THREE ROUTES THIS PRODUCT PUBLISHES.
 *
 * `/api/v1/auth/register`, `/api/v1/auth/verify-email` and
 * `/api/v1/auth/resend-verification`. Until this file `AuthModule` registered
 * no controller and `pnpm check:openapi` reported four routes; it reports seven
 * from here.
 *
 * # All three are `@Public()`, and therefore NOT CSRF-covered
 *
 * Carry-forward ruling 56, stated here rather than left for a reviewer to
 * discover. `CsrfGuard` skips `@Public()` routes deliberately: the expected
 * token derives from an `HttpOnly` cookie a page cannot read, so a public route
 * demanding a double-submit token would refuse every caller with no client-side
 * remedy — and it would refuse hardest for exactly the users who arrive
 * carrying a stale session cookie. That is correct for these three, all of
 * which are reachable by someone with no account at all, and it means a
 * cross-site `POST` to any of them will execute. What that buys an attacker is
 * bounded by what the endpoints do: register creates an account under an
 * address they must control to use, verify-email needs a 256-bit secret they do
 * not have, and resend sends mail to an address they typed, rate limited per IP
 * and per address. Task 9's login endpoint has the same property and
 * **brings its own mechanism** — this guard does not cover it.
 *
 * # The response bodies are constants, and that is the security property
 *
 * `registerResponseSchema` and `resendVerificationResponseSchema` are single
 * literal statuses. A field whose value never varies with the account cannot
 * leak whether the account exists, which is what
 * `security/authentication.md` §7 requires and what
 * `auth.enumeration.integration.spec.ts` proves by byte comparison rather than
 * by inspection.
 *
 * `200`, not `201`. `api/conventions.md` §2 gives 201 to a creation, "with
 * `Location`" — and a `Location` header pointing at the new account is exactly
 * the disclosure this endpoint is built to avoid. A 201 for a new address and a
 * 200 for an existing one would be the whole oracle in the status line.
 *
 * # `@RequirePermission()` appears nowhere here
 *
 * It is still metadata no guard enforces (Task 12), so no route of this task's
 * may rely on it. `@Public()` is enforced today — by `AuthenticationGuard`,
 * which skips these three, and by the boot-time access assertion, which refuses
 * to start on a route that declares nothing.
 */
@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(
    @Inject(RegistrationService) private readonly registration: RegistrationService,
    @Inject(EmailVerificationService) private readonly verification: EmailVerificationService,
  ) {}

  /**
   * Creates an account, or does not, and says the same thing either way.
   *
   * `registration`: 3/hour per IP, fail closed
   * (`security/abuse-prevention.md` §1). That is a per-IP window only, so the
   * limiter has nothing to resolve from the body and nothing is silently
   * missed.
   */
  @Public()
  @RateLimit('registration')
  @ApiDoc({
    summary: 'Register an account.',
    description:
      'Creates an account and sends a verification link. The response is identical whether or ' +
      'not the address is already registered: an address that already has an account receives ' +
      'a notice about the attempt instead of a link, and nothing about the account changes.',
    responses: [
      {
        status: 200,
        description: 'Accepted. A message has been sent to the address, whatever it was.',
        schema: registerResponseSchema,
      },
      {
        status: 422,
        description:
          'The password appears in a public breach corpus (`PASSWORD_BREACHED`). This check ' +
          'is disabled by default and fails open, so its absence is not a claim about the password.',
      },
      { status: 429, description: 'Rate limited: 3 per hour per IP address.' },
    ],
  })
  @HttpCode(200)
  @Post('register')
  async register(
    @Body(new ZodValidationPipe(registerRequestSchema)) body: RegisterRequest,
    @Req() request: Request,
  ): Promise<RegisterResponse> {
    await this.registration.register({
      email: body.email,
      password: body.password,
      // `??` rather than leaving it absent: `User.name` is nullable and the
      // service takes `string | null`, so "the caller sent no name" is one
      // value rather than two.
      name: body.name ?? null,
      ...requestContextOf(request),
    });
    return { status: 'VERIFICATION_REQUIRED' };
  }

  /**
   * Redeems a verification link.
   *
   * `emailVerificationConsume`: 30/hour per IP, fail closed — a class added by
   * this task, because defaulting the route would have given it `generalSession`,
   * which resolves no scope on an unauthenticated request and warns about it
   * nowhere at the default log level (carry-forward ruling 55).
   */
  @Public()
  @RateLimit('emailVerificationConsume')
  @ApiDoc({
    summary: 'Confirm an email address.',
    description:
      'Redeems a single-use verification token and marks the address confirmed. Unknown, ' +
      'expired, already-used and superseded tokens all produce the same refusal, so the ' +
      'endpoint cannot be used to discover which addresses are registered.',
    responses: [
      {
        status: 200,
        description: 'The address is confirmed.',
        schema: verifyEmailResponseSchema,
      },
      {
        status: 422,
        description:
          'The link is not redeemable (`TOKEN_INVALID`). One code and one message for unknown, ' +
          'expired, already-used and superseded alike.',
      },
      { status: 429, description: 'Rate limited: 30 per hour per IP address.' },
    ],
  })
  @HttpCode(200)
  @Post('verify-email')
  async verifyEmail(
    @Body(new ZodValidationPipe(verifyEmailRequestSchema)) body: VerifyEmailRequest,
    @Req() request: Request,
  ): Promise<VerifyEmailResponse> {
    await this.verification.verify({ token: body.token, ...requestContextOf(request) });
    return { status: 'EMAIL_VERIFIED' };
  }

  /**
   * Sends the verification link again, or does not, and says the same thing
   * either way.
   *
   * Ruling G and carry-forward ruling 45: a failed send is not retried, not
   * queued, and nothing alerts on it, so without this route the first
   * verification email is authoritative and an SMTP blip locks somebody out
   * permanently.
   *
   * `emailVerificationResend`: 3/hour per account by the body's `email` field,
   * 10/hour per IP, fail closed. The per-account half is what stops one caller
   * aiming this at one address; the per-IP half is what stops it being an
   * outbound-email amplifier pointed at people who are not our customers.
   */
  @Public()
  @RateLimit('emailVerificationResend')
  @ApiDoc({
    summary: 'Send the verification link again.',
    description:
      'Issues a fresh verification link, which invalidates any previous one for that account. ' +
      'The response is identical for an address with no account, an address awaiting ' +
      'confirmation, and an address already confirmed.',
    responses: [
      {
        status: 200,
        description: 'Accepted. Whether anything was sent is deliberately not reported.',
        schema: resendVerificationResponseSchema,
      },
      {
        status: 429,
        description: 'Rate limited: 3 per hour per address and 10 per hour per IP address.',
      },
    ],
  })
  @HttpCode(200)
  @Post('resend-verification')
  async resendVerification(
    @Body(new ZodValidationPipe(resendVerificationRequestSchema)) body: ResendVerificationRequest,
    @Req() request: Request,
  ): Promise<ResendVerificationResponse> {
    await this.verification.resend({ email: body.email, ...requestContextOf(request) });
    return { status: 'VERIFICATION_REQUIRED' };
  }
}
