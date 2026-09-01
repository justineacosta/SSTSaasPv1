import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import {
  assertUserPrincipal,
  type ChangePasswordRequest,
  type ChangePasswordResponse,
  changePasswordRequestSchema,
  changePasswordResponseSchema,
  type ForgotPasswordRequest,
  type ForgotPasswordResponse,
  forgotPasswordRequestSchema,
  forgotPasswordResponseSchema,
  type LoginRequest,
  type LoginResponse,
  loginRequestSchema,
  loginResponseSchema,
  type LogoutRequest,
  logoutRequestSchema,
  type RegisterRequest,
  type RegisterResponse,
  registerRequestSchema,
  registerResponseSchema,
  type ResendVerificationRequest,
  type ResendVerificationResponse,
  resendVerificationRequestSchema,
  resendVerificationResponseSchema,
  type ResetPasswordRequest,
  type ResetPasswordResponse,
  resetPasswordRequestSchema,
  resetPasswordResponseSchema,
  type SessionResponse,
  sessionResponseSchema,
  type VerifyEmailRequest,
  type VerifyEmailResponse,
  verifyEmailRequestSchema,
  verifyEmailResponseSchema,
} from '@sentinel/contracts';
import type { Request, Response } from 'express';
import { AuthenticatedOnly, Public } from '../../common/decorators/access.decorator.js';
import { RefuseCrossSite } from '../../common/decorators/cross-site.decorator.js';
import { ApiDoc } from '../../common/decorators/openapi.decorator.js';
import { RateLimit } from '../../common/decorators/rate-limit.decorator.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import {
  clearedCsrfCookie,
  clearedSessionCookie,
  serialiseCsrfCookie,
  serialiseSessionCookie,
} from './cookies.js';
import { deriveCsrfToken } from './csrf-token.js';
import { EmailVerificationService } from './email-verification.service.js';
import { LoginService } from './login.service.js';
import { LogoutService } from './logout.service.js';
import { PasswordChangeService } from './password-change.service.js';
import { PasswordResetService } from './password-reset.service.js';
import { RegistrationService } from './registration.service.js';
import { requestContextOf } from './request-context.js';
import { SessionDocumentService } from './session-document.service.js';

/**
 * THE NINE ROUTES ON THIS CONTROLLER.
 *
 * Nine here, **thirteen in the product** — the health probes and the OpenAPI
 * document itself make up the difference, and `pnpm check:openapi` counts all
 * of them. Task 8 shipped `/register`, `/verify-email` and
 * `/resend-verification` and took that total from four to seven; Task 9 added
 * `/login`, `/logout` and `/session` and took it to ten; Task 10 adds
 * `/forgot-password`, `/reset-password` and `/change-password` and takes it to
 * thirteen. (L6: the heading previously said "the six routes this product
 * publishes", which contradicted the sentence below it.)
 *
 * # The Task 8 three are `@Public()`, and therefore NOT CSRF-covered
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
    @Inject(LoginService) private readonly logins: LoginService,
    @Inject(LogoutService) private readonly logouts: LogoutService,
    @Inject(SessionDocumentService) private readonly sessionDocument: SessionDocumentService,
    @Inject(PasswordResetService) private readonly passwordResets: PasswordResetService,
    @Inject(PasswordChangeService) private readonly passwordChanges: PasswordChangeService,
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
    requestBody: {
      description:
        'The address is lower-cased and trimmed before use. Unknown fields are rejected, not ' +
        'ignored: the schema is strict, so a typo in a field name is a 400 rather than a ' +
        'silently dropped value.',
      schema: registerRequestSchema,
    },
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
    requestBody: { schema: verifyEmailRequestSchema },
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
    requestBody: { schema: resendVerificationRequestSchema },
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

  /**
   * Exchanges a password for a session cookie, or for a pending-MFA token.
   *
   * `login`: 5 / 15 min per account keyed on the body's `email`, 20 / 15 min
   * per IP, fail closed (`security/abuse-prevention.md` §1). **This is the
   * first route on which a `{ bodyField }` principal source has ever
   * resolved** — the three routes above either carry no account in their body
   * or key on it for a different class — so it is also the first time the
   * per-account half of that table does anything at all. The two windows bite
   * independently, which is `security/authentication.md` §7's actual property:
   * one attacker guessing at one address must not consume the budget of
   * everybody behind the same egress address, and one attacker behind one
   * address must not lock out a whole tenant by naming their accounts in turn.
   *
   * `@RefuseCrossSite()` rather than CSRF. See the class docblock.
   */
  @Public()
  @RefuseCrossSite()
  @RateLimit('login')
  @ApiDoc({
    summary: 'Sign in.',
    description:
      'Verifies a password and issues a session. The response is one of exactly two shapes: ' +
      '`{ mfaRequired: false }` with a session cookie, or `{ mfaRequired: true, pendingToken }` ' +
      'with no cookie at all. Every failure — an address with no account, a wrong password, an ' +
      'account with no credential — is the same 401 `INVALID_CREDENTIALS`, and a full Argon2id ' +
      'verification is performed either way so the cases do not differ in cost. Repeated ' +
      'failures lock the account temporarily and notify its owner.',
    requestBody: {
      description:
        '`rememberMe` is optional. Absent means a session that ends with the browser; `true` ' +
        'means the 30-day absolute lifetime and a cookie carrying `Max-Age`. The schema is ' +
        'strict, so an unknown field is a 400 rather than a silently dropped value.',
      schema: loginRequestSchema,
    },
    responses: [
      {
        status: 200,
        description:
          'Authenticated, or authenticated so far. `Set-Cookie` carries `__Host-session` and ' +
          '`__Host-csrf` on the first shape and is absent on the second.',
        schema: loginResponseSchema,
      },
      {
        status: 401,
        description:
          'The credentials are not valid (`INVALID_CREDENTIALS`). Identical for an address with ' +
          'no account, a wrong password, and a credential that could not be read.',
      },
      {
        status: 403,
        description:
          'The account cannot be signed in to (`ACCOUNT_LOCKED`) — either a temporary ' +
          'brute-force lock or an administrative one, and the response deliberately does not ' +
          'say which — or the request was refused as cross-site (`CSRF_TOKEN_INVALID`). ' +
          '`ACCOUNT_LOCKED` is returned only when the password was otherwise correct: ' +
          'answering it to any attempt would confirm the address is registered.',
      },
      {
        status: 429,
        description: 'Rate limited: 5 per 15 minutes per account and 20 per 15 minutes per IP.',
      },
    ],
  })
  @HttpCode(200)
  @Post('login')
  async login(
    @Body(new ZodValidationPipe(loginRequestSchema)) body: LoginRequest,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<LoginResponse> {
    const result = await this.logins.login({
      email: body.email,
      password: body.password,
      // `?? false` here rather than a `.default(false)` in the contract: the
      // wire contract should say "absent means the server's default", and the
      // default itself belongs to `SessionService.issue`. This is the one place
      // the absent case becomes a value.
      rememberMe: body.rememberMe ?? false,
      ...requestContextOf(request),
    });

    if (result.kind === 'mfa-required') {
      // NO `Set-Cookie` AT ALL. D9: the pending credential travels in the body,
      // and nothing puts it in a browser's cookie jar — a cookie is ambient,
      // and a `PENDING_MFA` session must be presented deliberately.
      //
      // **It is unreachable by any route that ships today**, stated rather than
      // implied: `AuthenticationGuard` reads the session cookie and this token
      // is not in one, and `@AllowPendingMfa()` sits on no shipped handler.
      // Task 11 builds `mfa/verify`, and ADR-0018 is reserved for deciding how
      // this credential is delivered — the response SHAPE is pinned by
      // `loginResponseSchema` and already committed, so that decision can be
      // made without a breaking wire change.
      return { mfaRequired: true, pendingToken: result.pendingToken };
    }

    // BOTH COOKIES, IN ONE `Set-Cookie` ARRAY. The CSRF cookie is derived from
    // the session token rather than stored (`csrf-token.ts`), so it needs no
    // second source of truth and rotates whenever the session does. Its
    // `Max-Age` matches the session cookie's for `cookies.ts`'s reason: a CSRF
    // cookie that outlives its session, or dies before it, is a logged-in user
    // who cannot submit a form.
    response.setHeader('Set-Cookie', [
      serialiseSessionCookie({ value: result.token, maxAgeSeconds: result.cookieMaxAgeSeconds }),
      serialiseCsrfCookie({
        value: deriveCsrfToken(result.token),
        maxAgeSeconds: result.cookieMaxAgeSeconds,
      }),
    ]);
    return { mfaRequired: false };
  }

  /**
   * Revokes the caller's own session and clears both cookies.
   *
   * `generalSession`, declared explicitly — and **it resolves nothing today**.
   * The limiter runs before the authentication guard by design
   * (`architecture/backend.md` §3), so `principalSource: 'authenticated'`
   * resolves on no request; the class is fail-open, and carry-forward ruling 55
   * records that nothing reports this at the default log level. Declaring it is
   * honest bookkeeping rather than a control. A route with no decorator falls
   * to the same class *silently*, which is strictly worse — the decorator is
   * what lets `auth.controller.spec.ts`'s exhaustiveness test say somebody
   * chose.
   *
   * **204 with no body**, so there is nothing to say about what was revoked.
   */
  @AuthenticatedOnly()
  @RateLimit('generalSession')
  @ApiDoc({
    summary: 'Sign out.',
    description:
      'Revokes the session the request was made with and clears both cookies. The session row ' +
      'is retained with `revokedAt` set rather than deleted: it is the forensic record that the ' +
      'session existed, and the security settings screen reads it. Revocation is immediate — ' +
      'the cache entry is tombstoned before the row is written. Requires `X-CSRF-Token`.',
    requestBody: {
      description: 'Empty. The schema is strict, so a body with anything in it is a 400.',
      schema: logoutRequestSchema,
    },
    responses: [
      { status: 204, description: 'Signed out. Both cookies are cleared.' },
      { status: 401, description: 'No usable session (`UNAUTHENTICATED` or `SESSION_EXPIRED`).' },
      { status: 403, description: 'Missing or mismatched `X-CSRF-Token` (`CSRF_TOKEN_INVALID`).' },
    ],
  })
  @HttpCode(204)
  @Post('logout')
  async logout(
    @Body(new ZodValidationPipe(logoutRequestSchema)) _body: LogoutRequest,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.logouts.logout({
      ...principalOf(request),
      ...requestContextOf(request),
    });

    // Both, with the same attributes they were set with — a browser matches a
    // replacement cookie on name, domain and path together, so a clearing
    // header that shortened the attribute list would leave the original in
    // place. `cookies.ts` repeats the list rather than deriving it for exactly
    // this reason.
    response.setHeader('Set-Cookie', [clearedSessionCookie(), clearedCsrfCookie()]);
  }

  /**
   * The current principal, the active organisation, the effective permission
   * set, and an entitlements placeholder.
   *
   * `generalSession`, and the same sentence applies as on `logout`: it resolves
   * nothing today.
   *
   * **`permissions` is `[]` and that is the truth, not a stub.** There is no
   * role-assignment machinery until Task 12 and nothing anywhere computes an
   * effective permission set, so inventing a value would be a lie the frontend
   * would believe and act on. `session-document.service.ts` carries the full
   * argument, and its spec asserts the empty array so a future edit has to come
   * past it.
   */
  @AuthenticatedOnly()
  @RateLimit('generalSession')
  @ApiDoc({
    summary: 'Describe the current session.',
    description:
      'The document the permission-aware frontend reads and nothing else. `permissions` is ' +
      'currently always empty: role assignment does not exist yet, so the effective permission ' +
      'set genuinely is empty rather than unavailable. `entitlements` is an open object and is ' +
      'currently always empty — billing arrives in a later phase. `activeOrganization` is null ' +
      'until an organisation has been chosen. The session identifier is deliberately absent.',
    responses: [
      { status: 200, description: 'The session document.', schema: sessionResponseSchema },
      { status: 401, description: 'No usable session, or MFA has not been completed.' },
    ],
  })
  @Get('session')
  async session(@Req() request: Request): Promise<SessionResponse> {
    return this.sessionDocument.forPrincipal(principalOf(request));
  }

  /**
   * Asks for a password-reset link, or does not, and says the same thing either
   * way.
   *
   * D5. `{ status: 'RESET_REQUESTED' }` for an address with no account, one
   * awaiting confirmation, and one fully active alike.
   * `auth.enumeration.integration.spec.ts` proves that by byte comparison
   * rather than by inspection — and note that these are 200s with a constant
   * body, so unlike login's refusals the comparison needs no `requestId`
   * substitution (carry-forward ruling 77).
   *
   * **THE TIMING RESIDUAL IS ACCEPTED, NOT CLOSED.** A path that sends pays an
   * SMTP round trip and a path that does not costs nothing, so the latency
   * separates the cases the bytes do not. That is carry-forward ruling 68 on a
   * third endpoint and it is not closable before the Phase 4 queue. Measured
   * figures are in this task's report and in `security/authentication.md` §6.
   *
   * `passwordReset`: 3/hour per address keyed on the body's `email`, 10/hour
   * per IP, fail closed. The per-account half is what stops one caller aiming
   * this at one address; the per-IP half is what stops it being an
   * outbound-email amplifier pointed at people who are not our customers.
   *
   * `@RefuseCrossSite()` rather than CSRF — D6, and see the class docblock.
   */
  @Public()
  @RefuseCrossSite()
  @RateLimit('passwordReset')
  @ApiDoc({
    summary: 'Ask for a password-reset link.',
    description:
      'Sends a single-use reset link. The response is identical whether or not the address has ' +
      'an account, and whether or not that account has confirmed its address — nothing about ' +
      'which case occurred reaches the caller. An account that has never confirmed its address ' +
      'does receive a link; an administratively locked or disabled one does not.',
    requestBody: {
      description: 'The address is lower-cased and trimmed before use. The schema is strict.',
      schema: forgotPasswordRequestSchema,
    },
    responses: [
      {
        status: 200,
        description: 'Accepted. Whether anything was sent is deliberately not reported.',
        schema: forgotPasswordResponseSchema,
      },
      {
        status: 403,
        description: 'The request was refused as cross-site (`CSRF_TOKEN_INVALID`).',
      },
      {
        status: 429,
        description: 'Rate limited: 3 per hour per address and 10 per hour per IP address.',
      },
    ],
  })
  @HttpCode(200)
  @Post('forgot-password')
  async forgotPassword(
    @Body(new ZodValidationPipe(forgotPasswordRequestSchema)) body: ForgotPasswordRequest,
    @Req() request: Request,
  ): Promise<ForgotPasswordResponse> {
    await this.passwordResets.request({ email: body.email, ...requestContextOf(request) });
    return { status: 'RESET_REQUESTED' };
  }

  /**
   * Redeems a reset link and replaces the password.
   *
   * `passwordResetConsume`: 20/hour per IP, fail closed — a class added by this
   * task, because the body is `{ token, password }` and carries no account to
   * key a per-account window on. Defaulting the route was not available
   * (carry-forward ruling 55), and reusing `passwordReset` would have declared
   * a `perPrincipal` scope sourced from a body field that does not exist —
   * resolving nothing on every request while the per-IP half resolved.
   *
   * **No `Set-Cookie` at all**, and that is a decision rather than an omission:
   * completing a reset revokes *every* session (D2), including any the caller
   * happened to be holding, and issuing a fresh one here would sign in whoever
   * redeemed the link. They sign in afterwards with the password they just
   * chose, which is the step that proves they know it.
   */
  @Public()
  @RefuseCrossSite()
  @RateLimit('passwordResetConsume')
  @ApiDoc({
    summary: 'Choose a new password from a reset link.',
    description:
      'Redeems a single-use reset token, replaces the password, and signs every session out — ' +
      'including any the caller is holding. No session is issued: sign in afterwards with the ' +
      'new password. Unknown, expired, already-used and superseded tokens, and a link for an ' +
      'account that is not active, all produce the same refusal.',
    requestBody: { schema: resetPasswordRequestSchema },
    responses: [
      {
        status: 200,
        description: 'The password is replaced and every session is revoked.',
        schema: resetPasswordResponseSchema,
      },
      {
        status: 403,
        description: 'The request was refused as cross-site (`CSRF_TOKEN_INVALID`).',
      },
      {
        status: 422,
        description:
          'The link is not redeemable (`TOKEN_INVALID`) — one code and one message for unknown, ' +
          'expired, already-used, superseded and not-active alike; or the password appears in a ' +
          'public breach corpus (`PASSWORD_BREACHED`), which is checked before the link is spent ' +
          'so a refusal does not cost the link.',
      },
      { status: 429, description: 'Rate limited: 20 per hour per IP address.' },
    ],
  })
  @HttpCode(200)
  @Post('reset-password')
  async resetPassword(
    @Body(new ZodValidationPipe(resetPasswordRequestSchema)) body: ResetPasswordRequest,
    @Req() request: Request,
  ): Promise<ResetPasswordResponse> {
    await this.passwordResets.reset({
      token: body.token,
      password: body.password,
      ...requestContextOf(request),
    });
    return { status: 'PASSWORD_RESET' };
  }

  /**
   * Changes the password of the signed-in caller, who must prove the current
   * one.
   *
   * `passwordChange`: 10/hour per IP, fail closed — a new class, and the one
   * row in `abuse-prevention.md` §1 that is a security control rather than
   * bookkeeping. This endpoint verifies a password, so it is a
   * credential-guessing oracle for anybody holding a stolen session.
   *
   * **`CsrfGuard` governs this route**, so it carries no `@RefuseCrossSite()` —
   * D6, and the same reasoning `logout` carries. It is cookie-authenticated, so
   * the double-submit token has something to bind to, which is exactly what a
   * public route cannot offer (carry-forward ruling 56).
   *
   * **The response replaces both cookies.** Every other session is revoked and
   * the caller's own is rotated, so the token in the browser before the change
   * cannot be used after it — `security/authentication.md` §3 lists a password
   * change as a privilege change. If there was nothing left to rotate, because
   * the caller's session was revoked concurrently, the cookies are cleared
   * instead.
   */
  @AuthenticatedOnly()
  @RateLimit('passwordChange')
  @ApiDoc({
    summary: 'Change your password.',
    description:
      'Requires the current password as well as a session: changing a password from a stolen ' +
      'session without proving the old one is an account-takeover step, not a settings edit. ' +
      'Every other session is signed out and this one is rotated, so `Set-Cookie` carries a new ' +
      '`__Host-session` and `__Host-csrf`. Requires `X-CSRF-Token`.',
    requestBody: { schema: changePasswordRequestSchema },
    responses: [
      {
        status: 200,
        description:
          'The password is changed. Every other session is revoked and this one is rotated.',
        schema: changePasswordResponseSchema,
      },
      {
        status: 401,
        description:
          'The current password is wrong (`INVALID_CREDENTIALS`), or there is no usable ' +
          'session (`UNAUTHENTICATED` or `SESSION_EXPIRED`).',
      },
      { status: 403, description: 'Missing or mismatched `X-CSRF-Token` (`CSRF_TOKEN_INVALID`).' },
      {
        status: 422,
        description:
          'The new password appears in a public breach corpus (`PASSWORD_BREACHED`). This check ' +
          'is disabled by default and fails open, so its absence is not a claim about the ' +
          'password.',
      },
      { status: 429, description: 'Rate limited: 10 per hour per IP address.' },
    ],
  })
  @HttpCode(200)
  @Post('change-password')
  async changePassword(
    @Body(new ZodValidationPipe(changePasswordRequestSchema)) body: ChangePasswordRequest,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ChangePasswordResponse> {
    const result = await this.passwordChanges.change({
      ...principalOf(request),
      currentPassword: body.currentPassword,
      newPassword: body.newPassword,
      ...requestContextOf(request),
    });

    if (result.token === null) {
      // Nothing was left to rotate — the caller's session was revoked while
      // this request ran. The password IS changed, so this is still a 200;
      // clearing the cookies signs them out rather than leaving a browser
      // holding a credential that now resolves to nothing.
      response.setHeader('Set-Cookie', [clearedSessionCookie(), clearedCsrfCookie()]);
      return { status: 'PASSWORD_CHANGED' };
    }

    // Both cookies, in one `Set-Cookie` array, exactly as login sets them. The
    // CSRF cookie is derived from the session token rather than stored, so it
    // rotates whenever the session does — which is the whole reason a rotation
    // here does not leave a signed-in user unable to submit a form.
    response.setHeader('Set-Cookie', [
      serialiseSessionCookie({ value: result.token, maxAgeSeconds: result.cookieMaxAgeSeconds }),
      serialiseCsrfCookie({
        value: deriveCsrfToken(result.token),
        maxAgeSeconds: result.cookieMaxAgeSeconds,
      }),
    ]);
    return { status: 'PASSWORD_CHANGED' };
  }
}

/**
 * The authenticated caller, or a loud failure.
 *
 * `AuthenticationGuard` sets `request.principal` on every non-public route, so
 * `undefined` here is unreachable in a booted application — the boot-time
 * access assertion refuses to start on a route that declares nothing, and both
 * handlers above declare `@AuthenticatedOnly()`. It **throws** rather than
 * coalescing to an anonymous default, for the reason `assertUserPrincipal`'s own
 * docblock gives: a privileged path reachable by omission is only safe if
 * reaching it is loud. A `?? { userId: '', sessionId: '' }` here would revoke
 * session `''` and answer a session document for user `''`.
 *
 * `assertUserPrincipal` is what refuses the `apiKey` arm, which Phase 2 cannot
 * construct and Task 12 will have to decide about.
 */
function principalOf(request: Request): { userId: string; sessionId: string } {
  const principal = request.principal;
  if (principal === undefined) {
    throw new Error(
      'Reached an authenticated handler with no principal on the request. AuthenticationGuard did not run.',
    );
  }
  return assertUserPrincipal(principal);
}
