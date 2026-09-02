import { Injectable } from '@nestjs/common';
import { newId } from '@sentinel/db';
import type { AuditAction, AuditResourceType } from './audit.actions.js';
import {
  PLATFORM_AUDIT_ACTOR_TYPES,
  type PlatformAuditActorType,
} from './platform-audit.service.js';

/**
 * The same four `ActorType` values, under a name that does not say "platform".
 *
 * Re-exported rather than restated: `enum ActorType` is one enum and both
 * tables carry it, so a second literal list would be a second thing to keep in
 * step with `schema.prisma` — carry-forward ruling 13's family, and the
 * duplication `enum-parity.spec.ts` exists to catch. The alias is here so a
 * reader of this file is not sent to the platform service to find out what an
 * actor is.
 */
export const AUDIT_ACTOR_TYPES = PLATFORM_AUDIT_ACTOR_TYPES;
export type AuditActorType = PlatformAuditActorType;

/**
 * The row this service writes, minus the id and the timestamp the database
 * fills in.
 *
 * `organizationId` is the one field `PlatformAuditEventInput` does not have,
 * and it is required rather than derived. The column is NOT NULL and Prisma has
 * no way to read the transaction's `app.organization_id` back out, so somebody
 * has to name it — and the honest place for that is the call site, which
 * already knows.
 *
 * **A caller naming the wrong organisation is refused by the database, not by
 * this class.** `AuditEvent`'s RLS policy carries a `WITH CHECK` comparing the
 * inserted `organizationId` against `current_setting('app.organization_id',
 * true)`, so an insert that disagrees with the transaction it is in fails. That
 * is layer 2 doing exactly the job ADR-0006 gives it: the application field is
 * checked against something the application did not supply.
 *
 * Every other field follows `PlatformAuditEventInput` exactly, including the
 * `string | null` rather than optional discipline: `null` is a caller saying
 * "not recorded", an absent property is a caller who forgot, and an audit row
 * has to be able to tell those apart.
 */
export interface AuditEventInput {
  readonly organizationId: string;
  readonly actorType: AuditActorType;
  readonly actorId: string | null;
  readonly action: AuditAction;
  readonly resourceType: AuditResourceType;
  readonly resourceId: string | null;
  /**
   * Redacted by the caller before it gets here, per `security/audit.md` §5.
   * **No raw secret ever goes in** — not a password, not a token, not a session
   * cookie.
   */
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly requestId: string | null;
}

/**
 * The one Prisma capability this service needs, as a narrow port — the same
 * shape `PlatformAuditEventDelegate` takes, for the same reason: a service
 * typed against the whole client makes every spec that touches it either a mock
 * of the world or an integration test.
 */
export interface AuditEventDelegate {
  create(args: {
    data: {
      id: string;
      organizationId: string;
      actorType: AuditActorType;
      actorId: string | null;
      action: string;
      resourceType: string;
      resourceId: string | null;
      metadata: Readonly<Record<string, string | number | boolean | null>>;
      ip: string | null;
      userAgent: string | null;
      requestId: string | null;
    };
  }): Promise<unknown>;
}

/** Whatever the caller's transaction handle is, narrowed to this one table. */
export interface AuditTransaction {
  auditEvent: AuditEventDelegate;
}

/**
 * WRITES THE AUDIT EVENTS THAT HAVE AN ORGANISATION (ADR-0019).
 *
 * `CLAUDE.md`'s tenth critical rule and `security/audit.md` §2 both require an
 * audit event in the **same transaction** as the change it describes: if the
 * change rolls back so does the event, and if the event fails so does the
 * change. That is why this class has exactly one method and why it takes the
 * transaction rather than opening one. A `write()` that opened its own
 * transaction would satisfy the sentence and break the rule.
 *
 * **The transaction it is handed must be a tenant transaction.** `AuditEvent`
 * carries RLS keyed on `organizationId`, and the policy's `WITH CHECK` compares
 * the inserted value against `current_setting('app.organization_id', true)`. A
 * handle from a bare client — `PRISMA`, connecting as `sentinel_app` — leaves
 * that setting NULL and the insert is refused. Nothing in this class can make
 * that mistake for a caller, and nothing in it can rescue a caller who does:
 * the type says `AuditTransaction`, and only `withTenantTransaction` produces
 * one with the setting live.
 *
 * **It does not choose the table**, and neither does `PlatformAuditService`.
 * ADR-0019's routing rule is the presence of an organisation, so a caller with
 * one writes here and a caller without one writes there. Neither service can
 * reach the other's table, which is what makes the rule structural instead of
 * remembered.
 *
 * **The table is append-only below this code.** `UPDATE` and `DELETE` are
 * revoked from `sentinel_app` and a trigger raises on either, so an application
 * bug cannot rewrite a row it wrote — measured while cleaning up a probe on
 * 2026-09-02, where a `DELETE` issued as the schema owner was refused with
 * `AuditEvent is append-only: DELETE is not permitted`. That is a database
 * privilege, not a convention this class enforces.
 */
@Injectable()
export class AuditService {
  /**
   * Appends one event inside the caller's transaction.
   *
   * Returns the row id so a caller can correlate, and so a spec can assert that
   * a rolled-back transaction left no row with it.
   */
  async record(tx: AuditTransaction, input: AuditEventInput): Promise<string> {
    const id = newId('aud');
    await tx.auditEvent.create({
      data: {
        id,
        organizationId: input.organizationId,
        actorType: input.actorType,
        actorId: input.actorId,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        metadata: input.metadata,
        ip: input.ip,
        userAgent: input.userAgent,
        requestId: input.requestId,
      },
    });
    return id;
  }
}
