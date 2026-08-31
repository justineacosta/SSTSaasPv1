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

  // --- Task 9: login, logout and the lockout ladder -------------------------
  //
  // All four are `PlatformAuditEvent` rows and none of them may be an
  // `AuditEvent` (ruling 62, ADR-0019). A login happens before any organisation
  // is chosen — `Session.activeOrganizationId` is null for every session this
  // phase can create — and `AuditEvent.organizationId` is NOT NULL behind an
  // RLS policy that *refuses* the insert rather than merely rejecting the
  // column. Phase 3's `/audit-logs` platform view unions the two tables.

  /**
   * A password was accepted and a session was issued. The `resourceId` is the
   * user; `actorType` is `USER` because on this one row the actor really is
   * the account owner.
   */
  'LOGIN',
  /**
   * A login attempt did not produce a session.
   *
   * `actorType` is `SYSTEM` with a null actor, following
   * `REGISTRATION_BLOCKED_EXISTING_EMAIL` above: naming the account owner as
   * the actor of a failed login would be a false statement in an append-only
   * table, and the whole point of the row is that it was probably not them.
   *
   * Written for an attempt against an address with **no account** as well, with
   * a null `resourceId` — otherwise a credential-stuffing sweep across
   * addresses that are not customers leaves no trace at all. The attempted
   * address is deliberately not in the metadata: `ip` and `requestId` already
   * carry the forensic signal that matters ("this address failed against N
   * unknown accounts"), and an append-only table is the worst place to learn
   * the email address of somebody who is not a customer.
   */
  'LOGIN_FAILED',
  /**
   * The failed attempt that tripped the per-account lock.
   *
   * **Not in `security/audit.md` §4 before this task** — the other three were —
   * so it is added to the document in the same change, exactly as Task 8 added
   * its three. Written once per lock, on the attempt that sets `lockedUntil`,
   * and not on the attempts that arrive while the lock is already live: those
   * change no state (see `lockout.ts`), so a row for each of them would be an
   * append-only table an attacker can grow at will.
   */
  'ACCOUNT_LOCKED',
  /**
   * A session was revoked by its own holder. The `resourceId` is the `Session`,
   * not the user: the user is unchanged, and the session row is what moved.
   */
  'LOGOUT',
] as const;

export type PlatformAuditAction = (typeof PLATFORM_AUDIT_ACTIONS)[number];

/**
 * The `resourceType` values these events name.
 *
 * Deliberately narrow, and still narrow after Task 9. A registration, a
 * verification, a login and a lock are all events about a `User`; a logout is
 * an event about the `Session` it revoked, because the user is unchanged by it
 * and the session row is the thing that moved. A wider union would be a list of
 * values nothing writes, and `platform-audit.service.spec.ts` holds every entry
 * here to being a real Prisma model.
 */
export const PLATFORM_AUDIT_RESOURCE_TYPES = ['User', 'Session'] as const;

export type PlatformAuditResourceType = (typeof PLATFORM_AUDIT_RESOURCE_TYPES)[number];
