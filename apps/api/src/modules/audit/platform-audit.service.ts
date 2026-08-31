import { Injectable } from '@nestjs/common';
import { newId } from '@sentinel/db';
import type { PlatformAuditAction, PlatformAuditResourceType } from './platform-audit.actions.js';

/**
 * A restatement of `enum ActorType` in `schema.prisma`, subject to
 * carry-forward ruling 13: a restatement needs something that reads the schema,
 * not a comment. `platform-audit.service.spec.ts` compares this list against
 * `datamodelEnums()` and fails if either side gains a value the other lacks.
 *
 * Restated rather than imported because the generated Prisma client is fenced
 * off from application code by `no-restricted-imports`, and rather than taken
 * from `@sentinel/contracts` because it is not there: `enum-parity.spec.ts`
 * lists `ActorType` under `DB_ONLY_ENUMS` — no contract carries an actor until
 * Phase 3 builds the audit query API.
 */
export const PLATFORM_AUDIT_ACTOR_TYPES = ['USER', 'API_KEY', 'SYSTEM', 'PLATFORM_ADMIN'] as const;

export type PlatformAuditActorType = (typeof PLATFORM_AUDIT_ACTOR_TYPES)[number];

/**
 * The row this service writes, minus the id and the timestamp it fills in.
 *
 * `actorId`, `resourceId`, `ip`, `userAgent` and `requestId` are all
 * `string | null` rather than optional, deliberately. `security/audit.md` §3
 * calls `ip` and `userAgent` part of the event shape and the notice templates
 * make the same argument one layer over: **a caller must never invent them**,
 * and an explicit `null` is a caller saying "not recorded" rather than a caller
 * who forgot the field. Optional properties make those two indistinguishable.
 */
export interface PlatformAuditEventInput {
  readonly actorType: PlatformAuditActorType;
  readonly actorId: string | null;
  readonly action: PlatformAuditAction;
  readonly resourceType: PlatformAuditResourceType;
  readonly resourceId: string | null;
  /**
   * Redacted by the caller before it gets here, per `security/audit.md` §5.
   *
   * **No raw secret ever goes in.** Not a password, not a password hash, not a
   * verification token, not a session token — `TokenService`'s own docblock
   * says the raw token never enters an audit event's metadata, and
   * `auth.verification.integration.spec.ts` asserts it for the events this
   * task writes rather than trusting the sentence.
   */
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly requestId: string | null;
}

/**
 * The one Prisma capability this service needs, as a narrow port — the same
 * shape `TokenService`'s `VerificationTokenDelegate` uses and for the same
 * reason: a service typed against the whole client makes every spec that
 * touches it either a mock of the world or an integration test.
 */
export interface PlatformAuditEventDelegate {
  create(args: {
    data: {
      id: string;
      actorType: PlatformAuditActorType;
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
export interface PlatformAuditTransaction {
  platformAuditEvent: PlatformAuditEventDelegate;
}

/**
 * WRITES THE AUDIT EVENTS THAT HAVE NO ORGANISATION (ADR-0019).
 *
 * `CLAUDE.md`'s tenth critical rule and `security/audit.md` §2 both require an
 * audit event in the **same transaction** as the change it describes: if the
 * change rolls back so does the event, and if the event fails so does the
 * change. That is why this class has exactly one method and why it takes the
 * transaction rather than opening one. A `write()` that opened its own
 * transaction would satisfy the sentence and not the rule.
 *
 * **It does not choose the table.** ADR-0019's routing rule is the presence of
 * an organisation, not the kind of action — `EMAIL_VERIFIED` for a user who
 * belongs to no organisation is a platform event, and the same action for a
 * member acting inside one is a tenant event. This service only ever writes the
 * platform table, and a caller that has an organisation in hand must write
 * `AuditEvent` instead. Nothing here can make that mistake for them, because
 * this service has no way to reach `AuditEvent` at all.
 *
 * **The table is append-only below this code.** `UPDATE` and `DELETE` are
 * revoked from `sentinel_app` and two triggers raise on either, so an
 * application bug cannot rewrite a row it wrote. That is a database privilege,
 * not a convention this class enforces.
 */
@Injectable()
export class PlatformAuditService {
  /**
   * Appends one event inside the caller's transaction.
   *
   * Returns the row id so a caller can correlate, and so a spec can assert that
   * a rolled-back transaction left no row with it.
   */
  async record(tx: PlatformAuditTransaction, input: PlatformAuditEventInput): Promise<string> {
    const id = newId('pau');
    await tx.platformAuditEvent.create({
      data: {
        id,
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
