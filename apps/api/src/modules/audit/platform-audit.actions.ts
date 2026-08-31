/**
 * The action names `PlatformAuditEvent` rows may carry.
 *
 * `security/audit.md` §4 is the taxonomy and this is its transcription for the
 * platform table, in the same relationship `rate-limit.config.ts` has with
 * `abuse-prevention.md` §1: the document is the authority, the constant is the
 * transcription, and `platform-audit.service.spec.ts` asserts they agree.
 *
 * **§4 had no name for registration at all.** It lists `EMAIL_VERIFIED` under
 * Auth and nothing for the account being created, which is the first event in
 * every account-takeover investigation. `USER_REGISTERED` and the two beside it
 * are added to the document in the same change as this file, per `CLAUDE.md`'s
 * documentation rule.
 *
 * `action` is a plain `String` column in `schema.prisma`, not an enum, so
 * nothing in the database refuses a typo. This union is the only thing that
 * does, which is why every writer goes through `PlatformAuditService` and takes
 * its action from here.
 */
export const PLATFORM_AUDIT_ACTIONS = [
  /** An account was created. The `resourceId` is the new `User` id. */
  'USER_REGISTERED',
  /**
   * A registration named an address that already has an account, so nothing was
   * created and the account owner was emailed instead.
   *
   * `security/audit.md` §3: "Failures and denials are audited, not only
   * successes." This is the row that makes a distributed account-enumeration
   * sweep visible after the fact — the wire response is identical for both
   * paths by design, so without this event the sweep leaves no trace at all.
   */
  'REGISTRATION_BLOCKED_EXISTING_EMAIL',
  /** A verification email was requested again for an existing, unverified account. */
  'EMAIL_VERIFICATION_RESENT',
  /** §4's own name, already in the taxonomy before this task. */
  'EMAIL_VERIFIED',
] as const;

export type PlatformAuditAction = (typeof PLATFORM_AUDIT_ACTIONS)[number];

/**
 * The `resourceType` values these events name.
 *
 * Deliberately narrow. A registration and a verification are both events about
 * a `User`, and nothing in this task audits anything else; a wider union would
 * be a list of values nothing writes.
 */
export const PLATFORM_AUDIT_RESOURCE_TYPES = ['User'] as const;

export type PlatformAuditResourceType = (typeof PLATFORM_AUDIT_RESOURCE_TYPES)[number];
