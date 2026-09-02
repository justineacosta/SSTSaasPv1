/**
 * The rate-limit table from security/abuse-prevention.md §1, as configuration.
 *
 * Limits are configuration rather than constants because §1 says they are
 * overridable per plan. Phase 1 ships the defaults; the per-plan override
 * arrives with entitlements in Phase 10, and it reads this shape.
 *
 * One row of §1 is deliberately absent: **webhook test delivery, 10/hour per
 * endpoint**. Its scope is a webhook endpoint ID, which is neither an IP, a
 * principal, nor an organisation, and there is nothing in this codebase that
 * can resolve one until the webhooks module ships in Phase 9. Transcribing it
 * against the wrong scope would be worse than leaving it out, because it would
 * look enforced. It arrives with the module that can key it.
 */

export interface Window {
  readonly limit: number;
  readonly windowSeconds: number;
}

/**
 * Where the `perPrincipal` scope's identifier comes from.
 *
 * The three per-*account* rows of §1 — login, password reset, email
 * verification resend — are unauthenticated by definition: a failed login
 * carries no authenticated principal, and "5 / 15 min per account" means the
 * account being *attempted*, which lives in the request body. Reading
 * `request.principalId` for those classes resolves nothing, and because their
 * `perIp` scope does resolve, the miss would be skipped silently — a route that
 * looks limited, advertises a limit in its headers, and does not apply the
 * control that actually stops credential stuffing.
 *
 * `'authenticated'` is the session/API-key principal. `{ bodyField }` names the
 * field to read instead; its value is hashed before it becomes part of a key,
 * so an email address never lands in Redis or in a `KEYS` listing in plaintext.
 */
export type PrincipalSource = 'authenticated' | { readonly bodyField: string };

interface BaseRateLimitClassConfig {
  readonly perIp?: Window;
  readonly perOrganization?: Window;
  /**
   * What to do when the limiter cannot reach a decision — Redis is unavailable,
   * or no declared scope could be resolved.
   *
   * 'closed' on authentication endpoints: a Redis outage must not become a
   * window for credential stuffing. 'open' on read-only endpoints: an outage
   * should not lock every customer out of reading their own data.
   * See abuse-prevention.md §1.
   */
  readonly failMode: 'open' | 'closed';
}

/**
 * `principalSource` is **mandatory** whenever `perPrincipal` is declared, and
 * that is enforced by the type rather than by a comment.
 *
 * A comment saying "required" is what allowed the original defect: a class
 * declaring `perPrincipal` with no source silently defaulted to the
 * authenticated principal, which resolves to nothing on an unauthenticated
 * endpoint — and because such classes also declare `perIp`, the miss was
 * skipped without a signal. MFA verification, magic links and phone OTP are all
 * Phase 2 classes of exactly that shape, so this has to be a compile error
 * before they are written, not a review finding afterwards.
 */
export type RateLimitClassConfig = BaseRateLimitClassConfig &
  (
    | { readonly perPrincipal: Window; readonly principalSource: PrincipalSource }
    | { readonly perPrincipal?: undefined; readonly principalSource?: undefined }
  );

export const RATE_LIMIT_CLASSES = {
  login: {
    perPrincipal: { limit: 5, windowSeconds: 900 },
    perIp: { limit: 20, windowSeconds: 900 },
    principalSource: { bodyField: 'email' },
    failMode: 'closed',
  },
  registration: { perIp: { limit: 3, windowSeconds: 3600 }, failMode: 'closed' },
  passwordReset: {
    perPrincipal: { limit: 3, windowSeconds: 3600 },
    perIp: { limit: 10, windowSeconds: 3600 },
    // §1 reads "3 / hour per address". The address is the one being reset, not
    // a logged-in user — nobody is logged in on this endpoint.
    principalSource: { bodyField: 'email' },
    failMode: 'closed',
  },
  /**
   * Submitting a verification token — `POST /api/v1/auth/verify-email`.
   *
   * ADDED IN TASK 8, AND NOT A ROW TRANSCRIBED FROM §1's TABLE. §1 has a row
   * for the resend and none for the submission, so the figure below is a
   * decision made here and written into that table in the same change.
   *
   * **Defaulting it was not available.** A route carrying no class falls to
   * `generalSession`, which is `failMode: 'open'` with `perPrincipal:
   * 'authenticated'` as its only scope — unresolvable on an unauthenticated
   * route — and carry-forward ruling 55 records that nothing warns when that
   * happens at the default log level. The default is therefore not a weak limit
   * on this route; it is no limit and no signal. Applying
   * `emailVerificationResend` instead would be worse: its `principalSource` is
   * the body field `email`, which `verifyEmailRequestSchema` does not contain,
   * so the per-account half would resolve nothing on every single request while
   * the per-IP half resolved — the exact silent miss this file's
   * `PrincipalSource` docblock was written about.
   *
   * **Per IP only, because there is no account to key on.** The request body is
   * `{ token }` and nothing else. Deriving a principal from the token would
   * mean looking it up before the limiter could decide, which is a database
   * read bought by an unauthenticated caller — the thing the limiter runs first
   * to prevent.
   *
   * **30/hour is not about guessing the token.** `secret-token.ts` fixes the
   * secret at 32 random bytes, so brute force is infeasible at any rate this
   * table could express. What this bounds is an unmetered write attempt against
   * Postgres from an unauthenticated endpoint: every submission runs a
   * conditional `UPDATE` inside a transaction. A real user submits once, twice
   * if they mistype a copy-paste; 30 leaves a family behind one NAT or one
   * office egress address room to verify a batch of accounts in an hour, which
   * is the failure the tighter figures in this table risk.
   *
   * Fail closed, with the rest of the authentication classes: a Redis outage
   * must not become an unbounded write channel.
   */
  emailVerificationConsume: { perIp: { limit: 30, windowSeconds: 3600 }, failMode: 'closed' },
  /**
   * Submitting a reset token and a new password —
   * `POST /api/v1/auth/reset-password`.
   *
   * ADDED IN TASK 10, AND A DECISION RATHER THAN A TRANSCRIPTION. §1's table
   * has a row for *requesting* a reset (`passwordReset` above, 3/hour per
   * address and 10/hour per IP) and no row at all for completing one. The
   * figure below is chosen here and written into that document in the same
   * change, exactly as Task 8 did for `emailVerificationConsume`.
   *
   * **Defaulting it was not available**, for the reason `emailVerificationConsume`
   * records one entry down: a route carrying no class falls to `generalSession`,
   * which is `failMode: 'open'` with an unresolvable `perPrincipal` as its only
   * scope, and carry-forward ruling 55 says nothing reports that at the default
   * log level. The default is not a weak limit on this route; it is no limit
   * and no signal.
   *
   * **Reusing `passwordReset` was not available either**, and the failure would
   * have been silent. Its `principalSource` is the body field `email`, which
   * `resetPasswordRequestSchema` — `{ token, password }` — does not contain, so
   * the per-account half would resolve nothing on every single request while
   * the per-IP half resolved. That is the exact silent miss this file's
   * `PrincipalSource` docblock was written about.
   *
   * **Per IP only, because there is no account in the body to key on.**
   * Deriving a principal from the token would mean a database read bought by an
   * unauthenticated caller *before* the limiter has decided anything, which is
   * what the limiter runs first to prevent.
   *
   * **20/hour rather than `emailVerificationConsume`'s 30, and the difference is
   * the Argon2id hash.** Neither figure is about guessing the token —
   * `secret-token.ts` fixes the secret at 32 random bytes, so brute force is
   * infeasible at any rate this table could express. What both bound is
   * unmetered work bought by an unauthenticated caller, and this endpoint's
   * unit of work is strictly larger: a full Argon2id hash of the submitted
   * password (~40 ms of CPU at production parameters, tuned to ~250 ms by
   * ADR-0014's target) plus a conditional `UPDATE` inside a transaction, where
   * verify-email pays only the transaction. A password reset is also a rarer
   * act than an email confirmation — one submission, two if a copy-paste goes
   * wrong — so 20 still leaves a family behind one NAT or one office egress
   * address room to complete several resets in an hour.
   *
   * Fail closed with the rest of the authentication classes: a Redis outage
   * must not become an unbounded CPU and write channel.
   */
  passwordResetConsume: { perIp: { limit: 20, windowSeconds: 3600 }, failMode: 'closed' },
  /**
   * Changing a password from inside a session —
   * `POST /api/v1/auth/change-password`.
   *
   * ADDED IN TASK 10, AND THIS ONE IS A SECURITY CONTROL RATHER THAN
   * BOOKKEEPING. The endpoint verifies the caller's **current** password, so it
   * is a credential-guessing oracle for anyone holding a stolen session: the
   * account is already fixed by the session cookie, the answer is a clean
   * 401/200 split, and none of it touches `User.failedLoginCount` or the
   * lockout ladder, which live on the login path. Without a class of its own
   * this route would fall to `generalSession` — 1000/minute, fail-open, and
   * resolving nothing (ruling 55) — which is to say a thousand password guesses
   * a minute against a known account with no lock, no notice and no log line.
   *
   * **THE PER-PRINCIPAL HALF WOULD BE THE RIGHT KEY AND RESOLVES NOTHING
   * TODAY.** The account being guessed at is the session's owner, and that is
   * exactly the scope this limit wants — but the rate limiter runs *before* the
   * authentication guard by design (`architecture/backend.md` §3), so
   * `principalSource: 'authenticated'` resolves on no request that reaches
   * here. Declaring it anyway would reproduce ruling 55's defect deliberately:
   * an unresolvable scope, skipped silently because the per-IP scope did
   * resolve, on a route whose headers would then advertise a limit that is not
   * applied. It is left undeclared and named here instead, and it is the reason
   * this class should be revisited by whichever task splits the limiter into an
   * early per-IP stage and a post-authentication per-principal one (ruling 59
   * wants that split for another reason already).
   *
   * **10/hour per IP.** Deliberately much tighter than the reset figures: a
   * password change is a rare, deliberate act — a real user does it once and
   * possibly twice — and unlike the reset endpoints this one has no legitimate
   * high-volume case behind a shared egress address. Ten guesses an hour
   * against one account is not a useful oracle; a thousand a minute is.
   *
   * Fail closed. An outage must not open a guessing window against every
   * account whose session somebody has stolen.
   */
  passwordChange: { perIp: { limit: 10, windowSeconds: 3600 }, failMode: 'closed' },
  /**
   * Submitting an MFA code — `POST /api/v1/auth/mfa/verify`.
   *
   * ADDED IN TASK 11, AND A DECISION RATHER THAN A TRANSCRIPTION. §1's table has
   * no MFA row at all, so the figure below is chosen here and written into that
   * document in the same change, exactly as Task 8 did for
   * `emailVerificationConsume` and Task 10 for the two beside it.
   *
   * **This is a control, not bookkeeping.** The endpoint checks a **six-digit**
   * secret. `security/authentication.md` §5's five-failure lock is the primary
   * bound and it is per pending session, which means a caller who is willing to
   * re-authenticate gets a fresh five each time — so the ladder alone bounds
   * guessing at 5 per login rather than absolutely. This class is what bounds
   * the outer loop.
   *
   * **60/hour per IP, and the arithmetic below was wrong by a factor of 1000
   * until review M5 divided it out.** Six digits is a small space: a million
   * codes, ±1 drift so three are live at any instant, which is a 3-in-10^6
   * chance per guess — about 333,333 expected guesses. At 60 an hour that is
   * 5,556 hours, or **0.63 years** from a single address. Not 630. Ten
   * addresses is under a month and a modest botnet is hours, so **the per-IP
   * figure is not the control**; it is the outer loop.
   *
   * **What actually bounds this is per-account, one endpoint up.** Reaching this
   * route at all costs a `PENDING_MFA` session, and minting one costs a
   * successful login, which `login` above limits to 5 per 15 minutes keyed on
   * the email address. Five logins an hour times five attempts each caps an
   * account near 100 attempts/hour however many addresses the attacker owns —
   * roughly 3,333 hours, about 4.6 months — and every attempt writes an
   * `MFA_CHALLENGE_FAILED` row, so the guessing is loud. That is a defensible
   * posture; the 630-year sentence described a different and imaginary one, and
   * the cost of leaving it standing was a future reader concluding there was
   * enormous headroom here. The figure is generous for a real user — a mistyped
   * code, a phone whose clock has drifted, a second device.
   *
   * **Per IP only, because there is no account in the body to key on.** The body
   * is `{ pendingToken, code }`. Deriving a principal from the pending token
   * would mean a Redis or Postgres read bought by an unauthenticated caller
   * *before* the limiter has decided anything, which is what the limiter runs
   * first to prevent — the same reasoning `emailVerificationConsume` and
   * `passwordResetConsume` record.
   *
   * Fail closed with the rest of the authentication classes: a Redis outage must
   * not become a window for guessing a second factor.
   */
  mfaVerify: { perIp: { limit: 60, windowSeconds: 3600 }, failMode: 'closed' },
  /**
   * The four authenticated MFA management routes — `POST /auth/mfa/enroll`,
   * `/confirm`, `/disable` and `/recovery-codes`.
   *
   * ADDED IN TASK 11. One class for the four rather than four classes, because
   * three of them verify the caller's **current password** and are therefore the
   * same oracle `passwordChange` is: the account is already fixed by the session
   * cookie, the answer is a clean 401/200 split, and none of it touches
   * `User.failedLoginCount` or the lockout ladder, which live on the login path.
   * `/confirm` carries no password and is grouped with them anyway — it is
   * reachable only in the window between an enrolment and its confirmation, and
   * a separate class for it would be a row in this table that says nothing new.
   *
   * **10/hour per IP, matching `passwordChange` deliberately.** Its comment
   * above carries the reasoning and the numbers, and this class copies both
   * rather than inventing a second answer to the same question: enrolling,
   * confirming, disabling and regenerating are all rare, deliberate acts with no
   * legitimate high-volume case behind a shared egress address, and each is a
   * password-guessing oracle at exactly the same strength.
   *
   * **`perPrincipal: 'authenticated'` IS DELIBERATELY NOT DECLARED**, and this
   * is the third class in this file to say so. The account being guessed at is
   * the session's owner, which is exactly the scope this limit wants — but the
   * limiter runs *before* the authentication guard by design
   * (`architecture/backend.md` §3), so an `'authenticated'` source resolves on no
   * request that reaches here. Declaring it would reproduce carry-forward ruling
   * 55's defect deliberately: an unresolvable scope, skipped in silence because
   * the per-IP scope did resolve, on a route whose headers would then advertise
   * a limit that is not applied. It is left undeclared and named here, and it is
   * one more reason to want the early-per-IP / late-per-principal split that
   * rulings 55, 59 and 90 already ask for.
   *
   * Fail closed. An outage must not open a window in which a stolen session can
   * guess a password, and it certainly must not open one in which a second
   * factor can be turned off at will.
   */
  mfaManagement: { perIp: { limit: 10, windowSeconds: 3600 }, failMode: 'closed' },
  emailVerificationResend: {
    perPrincipal: { limit: 3, windowSeconds: 3600 },
    // §1's table names only the per-account figure, but §1's opening sentence
    // says limits are applied per IP **and** per principal, and this class needs
    // the IP half more than most: it is unauthenticated, it names a third-party
    // address, and it makes us send mail. Without a per-IP bound one client can
    // name unlimited fresh addresses — an outbound-email amplifier aimed at
    // people who are not our customers, which is the case this document opens
    // by saying we limit abuse to prevent. The figure matches password reset,
    // the closest analogue in the table.
    perIp: { limit: 10, windowSeconds: 3600 },
    principalSource: { bodyField: 'email' },
    failMode: 'closed',
  },
  invitations: { perOrganization: { limit: 50, windowSeconds: 86_400 }, failMode: 'closed' },
  // §1 reads "Per plan (maxScansPerMonth), plus 10 / min burst". The monthly
  // figure is a quota, not a rate limit — quotas come from entitlements and are
  // checked before enqueue and again in the worker (§2). This is the burst.
  scanCreate: { perOrganization: { limit: 10, windowSeconds: 60 }, failMode: 'closed' },
  evidenceUpload: { perOrganization: { limit: 100, windowSeconds: 3600 }, failMode: 'closed' },
  reportGeneration: { perOrganization: { limit: 10, windowSeconds: 3600 }, failMode: 'closed' },
  generalSession: {
    perPrincipal: { limit: 1000, windowSeconds: 60 },
    principalSource: 'authenticated',
    failMode: 'open',
  },
  generalApiKey: {
    perPrincipal: { limit: 600, windowSeconds: 60 },
    principalSource: 'authenticated',
    failMode: 'open',
  },
} as const satisfies Record<string, RateLimitClassConfig>;

export type RateLimitClass = keyof typeof RATE_LIMIT_CLASSES;

/** The scopes a class may be keyed by, in the order the guard evaluates them. */
export const RATE_LIMIT_SCOPES = ['perIp', 'perPrincipal', 'perOrganization'] as const;

export type RateLimitScope = (typeof RATE_LIMIT_SCOPES)[number];
