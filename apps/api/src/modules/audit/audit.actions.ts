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
 * **Only names something in this codebase writes.** `security/audit.md` §4's
 * org-and-access group also lists `MEMBER_INVITED`,
 * `INVITATION_ACCEPTED/REVOKED` and `ORGANIZATION_SUSPENDED`; they belong to
 * Task 15 and to Phase 11's platform admin, and adding them here now would be a
 * union of values nothing writes — the same argument
 * `PLATFORM_AUDIT_RESOURCE_TYPES` makes about staying narrow. `MEMBER_REMOVED`
 * and `ROLE_CHANGED` left that group in Task 14, in the same change as the two
 * handlers that write them.
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
  /**
   * A member's role in this organisation was changed. The `resourceId` is the
   * `Membership` row, and `metadata` carries `before`, `after` and
   * `memberUserId`.
   *
   * The before/after values are role keys, which §5 permits: a role is not a
   * sensitive field, and "what did this become" is the whole question a role
   * audit answers. `memberUserId` is recorded because a membership id is
   * meaningless to a reader six months later, and because a member who has been
   * removed and re-added has several `Membership` rows for one person.
   */
  'ROLE_CHANGED',
  /**
   * A member was removed from this organisation. The `resourceId` is the
   * soft-deleted `Membership` row; `metadata` carries the role they held as
   * `before`, `null` as `after`, and `memberUserId`.
   *
   * **Unlike `ORGANIZATION_DELETED`, whose absence is argued above, this one
   * commits**, and the
   * difference is worth stating because the two look alike from a distance. A
   * membership removal is a soft delete: the row it names is still there, so
   * `AuditEvent`'s `Restrict` foreign key to `Organization` has nothing to
   * refuse. Nothing is deleted by this action at all.
   */
  'MEMBER_REMOVED',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/**
 * The `resourceType` values these events name.
 *
 * Deliberately narrow, on the same rule `PLATFORM_AUDIT_RESOURCE_TYPES`
 * follows: every entry must be a real Prisma model, and a union carrying values
 * nothing writes is a list nobody maintains.
 *
 * `Organization` is the subject of the first three actions — including the
 * switch, whose subject is the organisation the member began acting in rather
 * than the session row that carried them there. `Membership` is the subject of
 * the last two, and it is a distinct row rather than the organisation for a
 * reason: a role change and a removal are facts about one person's standing,
 * and naming the organisation would make every such event in a large tenant
 * point at the same id.
 *
 * The counts, computed rather than remembered — `AUDIT_ACTIONS` holds five
 * names (`ORGANIZATION_CREATED`, `ORGANIZATION_UPDATED`,
 * `ORGANIZATION_SWITCHED`, `ROLE_CHANGED`, `MEMBER_REMOVED`) and this constant
 * holds two.
 *
 * **This paragraph has been wrong once and has since claimed to have been wrong
 * twice, so here is the history as `git show` reports it.** Before Task 13's
 * review the sentence read "All four actions above are events about an
 * `Organization`" while `AUDIT_ACTIONS` held **three** names (`21f629f`) — that
 * is the one miscount, and `c10eeab` corrected it to "All three". Task 14 then
 * rewrote this paragraph and asserted a **second** historical error, "all three"
 * of a constant holding two: there was no such sentence. "All three" described
 * the actions, and it was right about them. Do not invent a second error to make
 * the first one rhyme. Carry-forward ruling 108: when a sentence states a count,
 * compute the count — including a count of the times somebody miscounted.
 */
export const AUDIT_RESOURCE_TYPES = ['Organization', 'Membership'] as const;

export type AuditResourceType = (typeof AUDIT_RESOURCE_TYPES)[number];
