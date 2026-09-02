/**
 * The action names `AuditEvent` rows may carry — the TENANT table, not the
 * platform one.
 *
 * `security/audit.md` §4 is the taxonomy and this is its transcription for the
 * tenant table, in exactly the relationship `platform-audit.actions.ts` has
 * with the same section: the document is the authority, this is the
 * transcription, and `audit.service.spec.ts` asserts they agree name by name.
 *
 * **ADR-0019's routing rule is the presence of an organisation, not the kind of
 * action.** Every name below is written by a handler that has an organisation
 * in hand — created it, is acting in it, or has just proved membership of it —
 * so every one of them is an `AuditEvent` and none may be a
 * `PlatformAuditEvent`. The reverse case is ruling 62: a login has no
 * organisation and `AuditEvent.organizationId` is NOT NULL behind an RLS policy
 * that refuses the insert rather than merely rejecting the column.
 *
 * **Only names this task writes.** `security/audit.md` §4's org-and-access
 * group also lists `MEMBER_INVITED`, `INVITATION_ACCEPTED/REVOKED`,
 * `MEMBER_REMOVED`, `ROLE_CHANGED` and `ORGANIZATION_SUSPENDED`; they belong to
 * Tasks 14 and 15 and to Phase 11's platform admin, and adding them here now
 * would be a union of values nothing writes — the same argument
 * `PLATFORM_AUDIT_RESOURCE_TYPES` makes about staying narrow.
 *
 * `action` is a plain `String` column in `schema.prisma`, not an enum, so
 * nothing in the database refuses a typo. This union is the only thing that
 * does, which is why every writer goes through `AuditService` and takes its
 * action from here.
 */
export const AUDIT_ACTIONS = [
  /**
   * An organisation was created, together with the creator's `OWNER`
   * membership, in one transaction. The `resourceId` is the new
   * `Organization`.
   *
   * There is one event rather than two. The membership is not a separate fact a
   * reader could act on: an organisation with no owner cannot exist, and a
   * `MEMBER_ADDED` row beside this one would say the same thing twice while
   * suggesting the two could have happened apart.
   */
  'ORGANIZATION_CREATED',
  /**
   * An organisation's own record was patched. `metadata` carries the fields
   * that changed and their before/after values, which §5 permits because a
   * name is not a sensitive field.
   */
  'ORGANIZATION_UPDATED',
  //
  // `ORGANIZATION_DELETED` IS DELIBERATELY ABSENT, AND IT IS NOT AN OVERSIGHT.
  //
  // It cannot be written. `AuditEvent.organizationId` references
  // `Organization.id` with `onDelete: Restrict`, so an event about a deletion
  // and the deletion it describes cannot be one transaction in either order.
  // Measured as `sentinel_app` against the compose Postgres on 2026-09-02,
  // inside one tenant transaction on an organisation with no prior history:
  //
  //     -- audit row first, then DELETE:
  //     ERROR:  update or delete on table "Organization" violates foreign key
  //             constraint "AuditEvent_organizationId_fkey" on table "AuditEvent"
  //     DETAIL: Key is still referenced from table "AuditEvent".
  //
  //     -- DELETE first, then the audit row:
  //     ERROR:  insert or update on table "AuditEvent" violates foreign key
  //             constraint "AuditEvent_organizationId_fkey"
  //     DETAIL: Key is not present in table "Organization".
  //
  //     -- DELETE with no audit row: DELETE 1, COMMIT.
  //
  // The consequence is worth stating plainly, because it decides what
  // `DELETE /api/v1/organizations/:id` can ever answer: `ORGANIZATION_CREATED`
  // above is written by the transaction that creates an organisation, so **no
  // organisation created through this API can ever be deleted** — the foreign
  // key refuses it, and the endpoint answers 409. That is the Phase 2
  // behaviour the plan asks for ("deletion fails while audit events exist, by
  // design"), reached by the database rather than by a check in application
  // code. The real purge path is Phase 11's platform admin, which has to
  // dispose of the audit history deliberately before the row can go.
  //
  // `security/audit.md` §4 still lists `ORGANIZATION_DELETED` in the taxonomy,
  // which is correct: it is a name a later phase's purge path will write. What
  // is not correct is a producer here that no transaction can commit.
  /**
   * A member changed which organisation their session is acting in, and the
   * session was rotated.
   *
   * **Not in `security/audit.md` §4 before this task**, and added to the
   * document in the same change — exactly as Task 9 added `ACCOUNT_LOCKED` and
   * Task 10 `PASSWORD_CHANGE_FAILED`. It earns a name because it is the first
   * event in the trail of everything the member then does inside this
   * organisation: without it, the organisation's own log begins mid-sentence
   * with whatever they touched first.
   *
   * The row lands in the organisation being switched **to**, which is where a
   * reader asking "who started acting here, and when" will look for it.
   */
  'ORGANIZATION_SWITCHED',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/**
 * The `resourceType` values these events name.
 *
 * Deliberately narrow, on the same rule `PLATFORM_AUDIT_RESOURCE_TYPES`
 * follows: every entry must be a real Prisma model, and a union carrying values
 * nothing writes is a list nobody maintains. All three actions above are events
 * about an `Organization` — including the switch, whose subject is the
 * organisation the member began acting in rather than the session row that
 * carried them there.
 *
 * "All three", counted: `AUDIT_ACTIONS` holds `ORGANIZATION_CREATED`,
 * `ORGANIZATION_UPDATED` and `ORGANIZATION_SWITCHED`. This sentence said "all
 * four" until Task 13's review, twenty-one lines below the constant it was
 * miscounting and in the same file as the comment explaining why
 * `ORGANIZATION_DELETED` cannot have a producer. It is the same defect
 * `security/audit.md` carried in the same change, and the defence that caught
 * both is the same one: when a sentence states a count, compute the count.
 */
export const AUDIT_RESOURCE_TYPES = ['Organization'] as const;

export type AuditResourceType = (typeof AUDIT_RESOURCE_TYPES)[number];
