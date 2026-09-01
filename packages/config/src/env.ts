import { z } from 'zod';

/** Coerces the string "true"/"false" that every env var actually is into a boolean. */
const booleanFromString = z.enum(['true', 'false']).transform((value) => value === 'true');

const port = z.coerce.number().int().min(1).max(65_535);

/**
 * A URL this product builds links or outbound requests against.
 *
 * `z.string().url()` alone delegates to `new URL()`, which accepts **any**
 * scheme. Measured during the Task 5 review: `javascript:alert(1)` and a
 * `data:text/html,...` value both passed `WEB_BASE_URL` validation, and
 * `buildTokenLink` then returned `javascript:alert(1)?token=…`, which
 * `escapeHtml` leaves byte-identical on its way into an email `href`.
 *
 * Task 5 is the change that made this reachable — before it, no configured URL
 * ended up in a document a user clicks. The value is operator-controlled rather
 * than attacker-controlled, so this is defence in depth and not a live hole;
 * it is still the wrong shape for a schema to permit, because there is no
 * environment in which any scheme but http or https is a valid answer here.
 *
 * `params.rule` rather than a message: `describeIssue` in `load-env.ts`
 * deliberately never reads `issue.message`, only rule parameters this
 * repository authored. `params` is authored here, exactly like the
 * `startsWith` above it, so the operator gets the reason instead of
 * "failed validation (custom)".
 */
const httpUrl = z
  .string()
  .url()
  .superRefine((value, ctx) => {
    // A failed `.url()` check above marks the result **dirty**, not aborted, and
    // Zod runs a `superRefine` over a dirty value — so this does receive
    // unparseable input, and an unguarded `new URL()` throws a raw TypeError
    // straight past `loadEnv`'s error envelope. Measured: it broke the spec
    // asserting no sentinel value ever reaches an error message, which is the
    // one guarantee this file exists to keep.
    let protocol: string;
    try {
      ({ protocol } = new URL(value));
    } catch {
      // Not a URL at all. `.url()` has already raised its own issue naming this
      // variable; a second issue would name it twice and say less.
      return;
    }

    if (protocol === 'http:' || protocol === 'https:') return;

    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      params: { rule: 'must use the http:// or https:// scheme' },
    });
  });

/**
 * The AES-256-GCM key `MfaFactor.secretEncrypted` is encrypted with, base64.
 *
 * **The length is checked HERE rather than at first use**, and that is the
 * whole reason this is a named schema instead of `z.string().min(1)`. A 31-byte
 * key passes every plausible per-field rule and then throws `Invalid key
 * length` out of `createCipheriv` — a native-module error naming no variable —
 * at the moment a user scans a QR code. A misconfigured key must fail the
 * process, not the first person who enrols.
 *
 * `params.rule` rather than a message, for `httpUrl`'s reason above:
 * `describeIssue` in `load-env.ts` never reads `issue.message`, only rule
 * parameters authored in this repository. That is also what keeps the key
 * itself out of the error text — this is the one field in this file whose value
 * *is* a credential, and `env.spec.ts` asserts it on this rule specifically
 * rather than relying on the general property.
 */
const MFA_SECRET_KEY_BYTES = 32;

const mfaSecretEncryptionKey = z.string().superRefine((value, ctx) => {
  // `Buffer.from(x, 'base64')` never throws — it decodes what it can and drops
  // the rest — so a non-base64 value arrives here as a short buffer and is
  // refused by the length rule below rather than by a parse failure. Stated
  // because "it must have thrown" is the assumption that would leave a
  // three-byte key running the product.
  if (Buffer.from(value, 'base64').length === MFA_SECRET_KEY_BYTES) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    params: {
      rule: `must be base64 for exactly ${String(MFA_SECRET_KEY_BYTES)} bytes (AES-256-GCM); generate one with: openssl rand -base64 32`,
    },
  });
});

export const sharedEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  // APP_ENV is deliberately separate from NODE_ENV: staging and production both
  // run with NODE_ENV=production but differ in ways that matter — feature flag
  // defaults, log verbosity, and whether the deny list covers our own hosts.
  // See .claude/operations/environments.md §3.
  APP_ENV: z.enum(['development', 'test', 'staging', 'production']),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'fatal']).default('info'),
});

const apiEnvObject = sharedEnvSchema.extend({
  API_PORT: port,
  API_BASE_URL: httpUrl,
  WEB_BASE_URL: httpUrl,

  DATABASE_URL: z.string().min(1).startsWith('postgresql://'),
  DIRECT_DATABASE_URL: z.string().min(1).startsWith('postgresql://'),

  REDIS_URL: z.string().min(1).startsWith('redis://'),

  STORAGE_ENDPOINT: z.string().url(),
  STORAGE_REGION: z.string().min(1),
  STORAGE_ACCESS_KEY_ID: z.string().min(1),
  STORAGE_SECRET_ACCESS_KEY: z.string().min(1),
  STORAGE_FORCE_PATH_STYLE: booleanFromString,
  STORAGE_BUCKET_EVIDENCE: z.string().min(1),
  STORAGE_BUCKET_REPORTS: z.string().min(1),
  STORAGE_BUCKET_UPLOADS: z.string().min(1),
  STORAGE_BUCKET_EXPORTS: z.string().min(1),

  MAIL_HOST: z.string().min(1),
  MAIL_PORT: port,
  MAIL_FROM: z.string().min(1),

  // SMTP authentication and transport security ------------------------------
  //
  // ADR-0016 defers the Resend HTTP adapter and states that the *same* SMTP
  // adapter serves staging and production, pointed at whatever relay that
  // environment provides. That sentence is only true if the adapter can present
  // a credential and negotiate TLS, and neither was expressible before these
  // three variables existed — so without them ADR-0016's central claim would be
  // aspirational, which is the exact defect class it was written to avoid.
  //
  // All three are API-only for the same reason as the password and token blocks
  // below: `apps/web/src/env.ts` parses its schema at module load in every
  // environment, so a variable on `sharedEnvSchema` is a variable every web
  // deploy must define in order to boot. The web app never sends mail.
  //
  // MAIL_SECURE means *implicit* TLS — TLS from the first byte, which is port
  // 465's convention. It defaults to `false` because that is correct for both
  // environments that exist: Mailpit on 1025 speaks plaintext, and a relay on
  // 587 expects a plaintext connection that is then upgraded with STARTTLS,
  // which nodemailer performs on its own whenever the server advertises it.
  // Defaulting this to `true` would break every environment in the repository
  // today in exchange for protecting none of them.
  MAIL_SECURE: booleanFromString.default('false'),
  // Optional and with no default, deliberately: Mailpit accepts unauthenticated
  // mail and inventing a placeholder credential would mean every environment
  // ships a fake one. `.min(1)` rather than allowing the empty string, so
  // `MAIL_USERNAME=` is refused at boot naming the variable rather than
  // silently meaning "absent" — declaring a credential and leaving it blank is
  // a mistake, not a configuration.
  MAIL_USERNAME: z.string().min(1).optional(),
  MAIL_PASSWORD: z.string().min(1).optional(),

  // Passwords ---------------------------------------------------------------
  //
  // API-only, and deliberately not on `sharedEnvSchema`. `apps/web/src/env.ts`
  // parses its schema at module load in every environment, so a variable added
  // to the shared schema becomes one every web deploy must define in order to
  // boot. The comment above `e2eEnvSchema` records the same rule for `E2E_PORT`.
  //
  // Every one of these carries a default, so nothing existing has to change to
  // keep booting. ADR-0014: the Argon2id parameters live in configuration
  // rather than in a constant precisely so an operator can raise them — after
  // tuning on production hardware, which the starting points below have not
  // been — without a code change, a build, or a deploy. `PasswordService`
  // reports `needsRehash` against them, so raised parameters take effect on
  // existing accounts at their owners' next successful login.
  //
  // security/authentication.md §2 is where m=64MiB / t=3 / p=4 comes from, and
  // it names them as a starting point only.
  PASSWORD_ARGON2_MEMORY_KIB: z.coerce.number().int().min(8).default(65_536),
  PASSWORD_ARGON2_TIME_COST: z.coerce.number().int().min(1).default(3),
  PASSWORD_ARGON2_PARALLELISM: z.coerce.number().int().min(1).max(255).default(4),

  // ADR-0015. The flag defaults to **false**, so no test suite anywhere
  // depends on a third party being reachable and no environment gets the
  // outbound call by accident; an environment that wants the check turns it on
  // explicitly. The check fails open on timeout, so the timeout is a latency
  // budget for registration and password change, not just an error bound.
  PASSWORD_BREACH_CHECK_ENABLED: booleanFromString.default('false'),
  PASSWORD_BREACH_CHECK_TIMEOUT_MS: z.coerce.number().int().min(1).default(2_000),
  PASSWORD_BREACH_CHECK_RANGE_URL: z.string().url().default('https://api.pwnedpasswords.com/range'),

  // Single-use secret tokens -----------------------------------------------
  //
  // API-only for the same reason as the password block above: the web app
  // never mints or redeems a token, and a variable on `sharedEnvSchema` is one
  // every web deploy must define in order to boot.
  //
  // `security/authentication.md` §6 fixes these three durations. They are here
  // rather than in a constant so an operator can shorten one during an incident
  // — a reset TTL cut from an hour to five minutes while an inbox compromise is
  // being contained — without a build and a deploy. Every one carries its §6
  // default, so nothing existing has to change to keep booting.
  //
  // ALL THREE ARE SECONDS, deliberately, rather than `_HOURS` / `_MINUTES` /
  // `_DAYS` matching §6's prose. One unit means `TokenService` performs one
  // multiplication for every purpose instead of three different ones, and a
  // mixed-unit set is how a `60` ends up read as the wrong thing.
  //
  // `.int().min(1)` and no maximum: a TTL of zero or less issues a token that
  // has already expired, which is a boot-time misconfiguration worth refusing.
  // A long TTL is a policy choice this layer has no basis to overrule.
  TOKEN_TTL_EMAIL_VERIFICATION_SECONDS: z.coerce.number().int().min(1).default(86_400),
  TOKEN_TTL_PASSWORD_RESET_SECONDS: z.coerce.number().int().min(1).default(3_600),
  // Read by Task 15 (invitation acceptance), not by anything in Task 4 —
  // `Invitation` carries its own `tokenHash` and is tenant-owned, so it never
  // becomes a `VerificationToken` row. It is declared here anyway because §6
  // gives all three one discipline, and `SECRET_TOKEN_TTL_SECONDS` in the auth
  // module exposes all three so the value is reachable rather than dead weight.
  TOKEN_TTL_INVITATION_SECONDS: z.coerce.number().int().min(1).default(604_800),

  // Sessions ----------------------------------------------------------------
  //
  // API-only, for the third time and the same reason: `apps/web/src/env.ts`
  // parses its schema at module load in every environment, so a variable on
  // `sharedEnvSchema` is one every web deploy must define in order to boot. The
  // web app never issues, resolves or revokes a session — it receives a cookie
  // it cannot read.
  //
  // SECONDS THROUGHOUT, matching the token block above. `security/
  // authentication.md` §3 states these as days and hours; one unit here means
  // `SessionService` performs one multiplication rather than three different
  // ones, and a mixed set is how a `60` gets read as the wrong thing.
  //
  // THE FIRST THREE ARE QUOTED FROM §3. Absolute lifetime 7 days, 30 with
  // "remember me", idle timeout 24h.
  SESSION_ABSOLUTE_LIFETIME_SECONDS: z.coerce.number().int().min(1).default(604_800),
  SESSION_REMEMBER_ME_LIFETIME_SECONDS: z.coerce.number().int().min(1).default(2_592_000),
  SESSION_IDLE_TIMEOUT_SECONDS: z.coerce.number().int().min(1).default(86_400),
  // THE LAST TWO ARE NOT QUOTED FROM ANYWHERE, and saying so is the point.
  //
  // §5 gives the pending-MFA session no number at all — it says the session is
  // "short-lived" and "can do nothing but complete MFA". Ten minutes is a
  // choice made here, long enough to fetch a phone and short enough that a
  // password-only credential is not left lying around; Task 11 owns the
  // enrolment flow that will show whether it is right.
  SESSION_PENDING_MFA_LIFETIME_SECONDS: z.coerce.number().int().min(1).default(600),
  // ADR-0005 promises "a short TTL" for the Redis cache and likewise gives no
  // number. Sixty seconds is the choice, and it is the bound on exactly one
  // residual: a revocation that cannot reach Redis (because Redis is the thing
  // that is down) revokes the row but cannot poison the cache entry, so a
  // surviving entry can serve a revoked session until it expires. See the
  // revocation docblock in `session.service.ts` — shorter narrows that window
  // at the cost of more Postgres reads; longer widens it.
  SESSION_CACHE_TTL_SECONDS: z.coerce.number().int().min(1).default(60),

  // MFA ---------------------------------------------------------------------
  //
  // API-only, for the fourth time and the same reason: the web app never
  // encrypts, decrypts or verifies anything, and a variable on
  // `sharedEnvSchema` is one every web deploy must define in order to boot.
  //
  // THE ONE VARIABLE IN THIS FILE WITH NO DEFAULT, AND THAT IS DELIBERATE.
  // Every other API variable carries one so nothing existing has to change to
  // keep booting. A default here would be a **shipped encryption key** — the
  // same defect as a shipped password, and worse in one respect: nobody would
  // ever discover it, because the product would work perfectly. `.env.example`
  // carries an obviously-fake local placeholder and the command to generate a
  // real one.
  //
  // `MfaFactor.secretEncrypted` is the only field in Phase 2 that is encrypted
  // rather than hashed, because verifying a TOTP code means recomputing it
  // (`schema.prisma`). This is the key it is encrypted with: AES-256-GCM, so
  // exactly 32 bytes, supplied base64.
  MFA_SECRET_ENCRYPTION_KEY: mfaSecretEncryptionKey,
});

/**
 * Argon2 additionally requires **memory >= 8 x parallelism**, a relationship no
 * per-field rule can express.
 *
 * (This block documents `checkArgon2Cost` below, which is the refinement it has
 * always described; a second cross-field rule joined it in Task 5 and the two
 * are now called side by side from one `superRefine` — see `apiEnvSchema`.)
 *
 * Without this, `PASSWORD_ARGON2_MEMORY_KIB=8 PASSWORD_ARGON2_PARALLELISM=4`
 * passes every rule above and then throws `Memory cost is too small` from a
 * native module inside `PasswordService`'s constructor at Nest boot — a message
 * that names neither variable. `development/setup.md` promises that a malformed
 * variable crashes at boot naming the variable; that promise is this layer's to
 * keep, not napi's. Measured 2026-08-25 against `@node-rs/argon2@2.1.0`:
 * m=8/p=4 throws, m=8/p=1 is fine, m=31/p=4 throws, m=32/p=4 is fine, and
 * m=24/p=3 is fine — the boundary is exactly 8p.
 *
 * Two issues, one per variable, so `EnvValidationError.variables` names both
 * and an operator can see which pair is in conflict. `too_small`/`too_big`
 * rather than `custom` because `describeIssue` in `load-env.ts` deliberately
 * never reads `issue.message` — it renders only authored rule parameters — so a
 * `custom` issue would print "failed validation (custom)" and say nothing. The
 * bounds below are the rule's own parameters; the rule is genuinely dynamic,
 * and a cost parameter bounded to 1..255 is not a credential.
 */
type ApiEnvInput = z.infer<typeof apiEnvObject>;

function checkArgon2Cost(env: ApiEnvInput, ctx: z.RefinementCtx): void {
  const minimumMemory = env.PASSWORD_ARGON2_PARALLELISM * 8;
  if (env.PASSWORD_ARGON2_MEMORY_KIB >= minimumMemory) return;

  ctx.addIssue({
    code: z.ZodIssueCode.too_small,
    minimum: minimumMemory,
    type: 'number',
    inclusive: true,
    path: ['PASSWORD_ARGON2_MEMORY_KIB'],
  });
  ctx.addIssue({
    code: z.ZodIssueCode.too_big,
    maximum: Math.floor(env.PASSWORD_ARGON2_MEMORY_KIB / 8),
    type: 'number',
    inclusive: true,
    path: ['PASSWORD_ARGON2_PARALLELISM'],
  });
}

/**
 * SMTP credentials are all-or-nothing.
 *
 * `nodemailer` given a username and no password does not fail — it drops `auth`
 * and connects unauthenticated. A relay then either rejects the message or, on
 * a permissive relay, accepts and drops it. Either way the symptom (mail not
 * arriving) appears nowhere near the cause (one unset variable), and the notice
 * emails `security/authentication.md` §2 and §5 require are precisely the mail
 * whose silent non-delivery nothing detects. Refusing at boot converts that
 * into an error naming the variable, which is what `development/setup.md`
 * promises configuration failures look like.
 *
 * The issue is raised as `invalid_type` / received `undefined` rather than
 * `custom` because `describeIssue` in `load-env.ts` never reads `issue.message`
 * — a `custom` issue would render as "failed validation (custom)" and name no
 * rule. `expected` and `received` are type-category tags, so this path cannot
 * carry the relay password into the error text; `env.spec.ts` pins that.
 */
function checkMailCredentialPair(env: ApiEnvInput, ctx: z.RefinementCtx): void {
  const hasUsername = env.MAIL_USERNAME !== undefined;
  const hasPassword = env.MAIL_PASSWORD !== undefined;
  if (hasUsername === hasPassword) return;

  ctx.addIssue({
    code: z.ZodIssueCode.invalid_type,
    expected: 'string',
    received: 'undefined',
    path: [hasUsername ? 'MAIL_PASSWORD' : 'MAIL_USERNAME'],
  });
}

/**
 * Every cross-field rule, called unconditionally.
 *
 * **No rule here may `return` out of this function.** Each check owns its own
 * early return; the composition below runs all of them so that a configuration
 * breaking two rules is reported once with both variables named, instead of
 * an operator fixing one and rediscovering the next on the following boot.
 */
/**
 * Two orderings between session lifetimes that no per-field rule can express.
 *
 * **"Remember me" must not shorten the session.** Every per-field rule passes
 * an inverted pair, both numbers look plausible in a `.env`, and the only
 * symptom is that the users who ticked the box are logged out first — a
 * misconfiguration with no error, no log line and a plausible-looking cause
 * somewhere else entirely. Inclusive at the boundary: setting the two equal
 * during an incident is a deliberate choice, not a mistake.
 *
 * **The pending-MFA session must not outlive a full one.**
 * `security/authentication.md` §5 makes the pending session "short-lived" and
 * says it "can do nothing but complete MFA". It is the credential an attacker
 * holds when they have the password and not the second factor, so a
 * configuration where it lives longer than an authenticated session inverts the
 * whole point of the factor. §5 gives no number, which is exactly why the
 * ordering is enforced here instead of a magnitude.
 *
 * **`too_small` and `too_big` rather than `custom`, and the reason is the
 * number, not the naming.** An earlier version of this comment said a `custom`
 * issue "renders as failed validation (custom) and names no rule", and
 * attributed that to a docblock on `checkArgon2Cost`. Both halves were wrong,
 * and the review measured it: `checkArgon2Cost` (above) carries no docblock —
 * the sentence being paraphrased is on `checkMailCredentialPair` — and
 * `load-env.ts`'s `describeIssue` has read `issue.params.rule` for a `custom`
 * issue since before this branch (`git show 2fceaaa:packages/config/src/load-env.ts`),
 * so an authored rule name does render.
 *
 * The real reason to use the typed codes is that they carry the **boundary** as
 * structured data: `describeIssue` renders `too_small` as
 * "must be at least <minimum>" and `too_big` as "must be at most <maximum>"
 * (`load-env.ts:52-55`), so an operator is told the number their other variable
 * has forced, not merely that two values disagree. A `custom` issue would have
 * to restate that number in prose, where it could drift from the one the rule
 * actually compared. It also matches `checkArgon2Cost` beside it, so all three
 * rules in this `superRefine` render the same way.
 *
 * The first of the two issues below is `too_small`, not `too_big`.
 */
function checkSessionLifetimes(env: ApiEnvInput, ctx: z.RefinementCtx): void {
  if (env.SESSION_REMEMBER_ME_LIFETIME_SECONDS < env.SESSION_ABSOLUTE_LIFETIME_SECONDS) {
    ctx.addIssue({
      code: z.ZodIssueCode.too_small,
      minimum: env.SESSION_ABSOLUTE_LIFETIME_SECONDS,
      type: 'number',
      inclusive: true,
      path: ['SESSION_REMEMBER_ME_LIFETIME_SECONDS'],
    });
  }

  if (env.SESSION_PENDING_MFA_LIFETIME_SECONDS > env.SESSION_ABSOLUTE_LIFETIME_SECONDS) {
    ctx.addIssue({
      code: z.ZodIssueCode.too_big,
      maximum: env.SESSION_ABSOLUTE_LIFETIME_SECONDS,
      type: 'number',
      inclusive: true,
      path: ['SESSION_PENDING_MFA_LIFETIME_SECONDS'],
    });
  }
}

export const apiEnvSchema = apiEnvObject.superRefine((env, ctx) => {
  checkArgon2Cost(env, ctx);
  checkMailCredentialPair(env, ctx);
  checkSessionLifetimes(env, ctx);
});

export const webEnvSchema = sharedEnvSchema.extend({
  WEB_PORT: port,
  WEB_BASE_URL: httpUrl,
  API_BASE_URL: httpUrl,
});

/**
 * The web schema plus the one variable only the end-to-end harness needs.
 *
 * `E2E_PORT` is the port the Playwright suite's own server binds, deliberately
 * not `WEB_PORT`. `playwright.config.ts` keeps `reuseExistingServer` locally so
 * consecutive runs stay fast, which means it attaches to whatever is already
 * listening — and a `next dev` left on `WEB_PORT` runs `APP_ENV=development`,
 * making the suite test a different application than CI does. That happened,
 * and it produced both a confusing false failure and (worse) a false pass. A
 * separate port makes the collision structurally impossible rather than a
 * habit.
 *
 * **It is a separate schema rather than a field on `webEnvSchema` because the
 * running web app must never need it.** `apps/web/src/env.ts` parses
 * `webEnvSchema` at module load in every environment, so a test-only variable
 * added there becomes a variable every production deploy has to define in order
 * to boot — a Playwright port gating a customer-facing server. Only
 * `playwright.config.ts` and the launcher's `--e2e-port` path parse this, which
 * is precisely where a missing `E2E_PORT` should fail loudly.
 */
export const e2eEnvSchema = webEnvSchema.extend({
  E2E_PORT: port,
});

export type SharedEnv = z.infer<typeof sharedEnvSchema>;
export type ApiEnv = z.infer<typeof apiEnvSchema>;
export type WebEnv = z.infer<typeof webEnvSchema>;
export type E2eEnv = z.infer<typeof e2eEnvSchema>;
