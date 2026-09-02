import { Inject, Injectable } from '@nestjs/common';
import {
  ERROR_CODES,
  LIST_LIMIT_MAX,
  type OrganizationCollection,
  type OrganizationResponse,
  type TenantContext,
} from '@sentinel/contracts';
import { newId, withTenantTransaction } from '@sentinel/db';
import { DomainError } from '../../common/errors/domain-error.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthRequestContext } from '../auth/request-context.js';
import { PRISMA } from '../../infrastructure/tokens.js';
import { encodeListCursor, type ListCursor } from './list-cursor.js';
import { USER_ORGANIZATION_LOOKUP } from './organizations.tokens.js';
import type { TenantTransactionBase, UserOrganizationLookup } from './user-organizations.store.js';

export interface CreateOrganizationCommand extends AuthRequestContext {
  readonly userId: string;
  readonly name: string;
  readonly slug: string;
}

export interface ListOrganizationsCommand {
  readonly userId: string;
  readonly limit: number;
  readonly cursor: ListCursor | null;
}

export interface UpdateOrganizationCommand extends AuthRequestContext {
  readonly userId: string;
  readonly name?: string | undefined;
}

/**
 * The refusal every cross-tenant and every missing-resource path answers with.
 *
 * **One function, because the two responses must be byte-identical.**
 * `api/authorization.md` §3 maps "not a member of the target organisation" and
 * "resource belongs to another tenant" onto the same row — 404
 * `RESOURCE_NOT_FOUND` — and `security/authorization.md` §6 says why: a 403
 * confirms the resource exists. `tenant-context.ts` has the same function for
 * the same reason, one layer up.
 */
function notFound(): DomainError {
  return new DomainError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Not found.', 404);
}

/**
 * D4, AS A PURE FUNCTION, SO THE RULE IS TESTABLE WITHOUT A REQUEST.
 *
 * `TenantContextGuard` resolves the organisation from
 * `Session.activeOrganizationId` and from nowhere else — never a path
 * parameter. So a path id naming a *different* organisation has been authorised
 * by nothing, whether or not the caller belongs to it, and the only safe answer
 * is 404.
 *
 * **404 covers three cases and must not distinguish them**: an id that does not
 * exist, an id belonging to somebody else's organisation, and an id belonging
 * to an organisation the caller genuinely is a member of but is not currently
 * acting in. The third is the surprising one and it is deliberate — answering
 * anything else would mean the path had selected the tenant, which is exactly
 * the input-controlled tenant selection `tenant-context.ts` exists to prevent.
 *
 * The alternative — resolving the organisation from `:id` and checking
 * membership here — would route around Task 12's entire pipeline: the
 * organisation-status check, the MFA-enrolment gate and the permission check
 * all key on the tenant the guard resolved, not on the path.
 */
export function assertPathIsActiveTenant(ctx: TenantContext, pathId: string): void {
  if (pathId !== ctx.organizationId) throw notFound();
}

/** True for Prisma's unique-constraint violation. */
function isUniqueConstraintViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}

/**
 * True for Prisma's foreign-key violation.
 *
 * Detected structurally rather than with `instanceof
 * PrismaClientKnownRequestError`, for the reason `identity.store.ts` gives: the
 * generated client is fenced off from application code by
 * `no-restricted-imports`, and importing the error class would mean widening a
 * security fence for a string comparison.
 */
function isForeignKeyViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2003';
}

/**
 * ORGANISATIONS: CREATE, LIST, READ, PATCH, DELETE.
 *
 * # Every write is one transaction, and the audit row is inside it
 *
 * `CLAUDE.md` rule 10 and `security/audit.md` §2. The transaction is the
 * control rather than a convention: if the change rolls back so does the event.
 * `AuditService.record` takes the handle instead of opening one, so there is no
 * way to write an event for a change that then failed.
 *
 * **Deletion is the exception, and it is a database fact rather than a
 * choice** — see `remove` below, and the transcript in `audit.actions.ts`.
 *
 * # It holds the base client, and every tenant-owned statement is wrapped
 *
 * `PRISMA` is the *unscoped* client, connecting as `sentinel_app`. A bare
 * `prisma.organization.findUnique` on it returns zero rows for every
 * organisation that exists — `Organization` carries `FORCE ROW LEVEL SECURITY`
 * keyed on `id`, and `active-organization.store.ts` has the measured
 * transcript. So every method below except `list` runs inside
 * `withTenantTransaction`, which sets `app.organization_id` and brings both
 * isolation layers live.
 *
 * `list` is the documented exception and the only one in this product: see
 * `user-organizations.store.ts` and ADR-0020.
 */
@Injectable()
export class OrganizationService {
  constructor(
    @Inject(PRISMA) private readonly base: TenantTransactionBase,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(USER_ORGANIZATION_LOOKUP) private readonly organizations: UserOrganizationLookup,
  ) {}

  /**
   * `POST /api/v1/organizations` — the organisation, the creator's `OWNER`
   * membership and the audit event, in one transaction.
   *
   * # The transaction is scoped to the organisation being created (D2)
   *
   * The id is minted first and `withTenantTransaction` is opened on it, so
   * `app.organization_id` names a row that does not exist yet. All three
   * inserts satisfy their policies inside it: `Organization`'s is keyed on `id`
   * with a `WITH CHECK`, and `Membership`'s and `AuditEvent`'s on
   * `organizationId`. **Measured, not assumed** — as `sentinel_app` against the
   * compose Postgres on 2026-09-02 all three inserts returned `INSERT 0 1`, and
   * the committed row read back inside a tenant transaction on the same id.
   *
   * # Slug uniqueness is the database constraint, not a pre-check (D3)
   *
   * `Organization.slug` is `@unique`. A `findUnique` followed by a `create` is
   * a race with a window between the two statements, and `CLAUDE.md`'s
   * "database integrity belongs in the database" rule says which of them is the
   * first line. So there is no pre-check at all: the `create` runs, P2002 is
   * caught, and the answer is 409. The loser of a genuine race gets exactly the
   * same response as somebody typing a slug that was taken an hour ago, which
   * is the right answer in both cases.
   *
   * # The creator is an `OWNER`, and `deletedAt` is written explicitly
   *
   * Carry-forward ruling 10: `status` and `deletedAt` are one fact, held
   * together by the `Membership_status_deletedAt_agree_check` constraint. The
   * column defaults to NULL, and writing it anyway is the habit that makes a
   * later `status: 'REMOVED'` without its partner look wrong at the call site
   * rather than at the database.
   */
  async create(command: CreateOrganizationCommand): Promise<OrganizationResponse> {
    const organizationId = newId('org');

    try {
      return await withTenantTransaction(this.base, organizationId, async (tx) => {
        const organization = await tx.organization.create({
          data: { id: organizationId, slug: command.slug, name: command.name },
          select: ORGANIZATION_COLUMNS,
        });

        // `Role` is deliberately-global reference data with no RLS, seeded by
        // `pnpm db:seed`. `findUniqueOrThrow` rather than `findUnique`: an
        // unseeded database is a deployment fault, and a null role id would
        // otherwise surface as a foreign-key error two statements later
        // blaming the membership.
        const owner = await tx.role.findUniqueOrThrow({
          where: { key: 'OWNER' },
          select: { id: true },
        });

        await tx.membership.create({
          data: {
            id: newId('mbr'),
            organizationId,
            userId: command.userId,
            roleId: owner.id,
            status: 'ACTIVE',
            // Ruling 10. Explicit, not defaulted.
            deletedAt: null,
          },
          select: { id: true },
        });

        await this.audit.record(tx, {
          organizationId,
          // The actor really is the user: they presented a live session cookie,
          // the CSRF token derived from it, and a verified address.
          actorType: 'USER',
          actorId: command.userId,
          action: 'ORGANIZATION_CREATED',
          resourceType: 'Organization',
          resourceId: organizationId,
          // The slug, because it is the one field of the new organisation that
          // appears in URLs and cannot be inferred from the id. The name is
          // deliberately not recorded here — `ORGANIZATION_UPDATED` carries
          // name changes, and recording it in both places would make the two
          // disagree after the first rename.
          metadata: { slug: command.slug },
          ip: command.ip,
          userAgent: command.userAgent,
          requestId: command.requestId,
        });

        return toResponse(organization);
      });
    } catch (error) {
      if (isUniqueConstraintViolation(error)) {
        throw new DomainError(
          ERROR_CODES.DUPLICATE_RESOURCE,
          'That organisation slug is already taken. Choose another.',
          409,
          { fields: { slug: 'Already taken.' } },
        );
      }
      throw error;
    }
  }

  /**
   * `GET /api/v1/organizations` — the caller's own organisations, paginated.
   *
   * **The clamp and the echo are one feature.** `listQuerySchema` clamps a
   * limit above `LIST_LIMIT_MAX` rather than rejecting it, so a client asking
   * for 500 gets 100 rows; `pagination.limit` reports the limit that was
   * applied, without which that client cannot tell 100 rows from "100 is all
   * there was" and stops paginating having seen a fraction of what it asked
   * for. `api/pagination.md` §4.
   *
   * The clamp is applied here as well as in the schema, and that is not
   * redundant: `pagination.limit` is a claim about what this method did, and a
   * claim that reads its number from somewhere other than the value it passed
   * to the query is a claim that can be wrong.
   *
   * `meta.total` is absent. §3 makes exact counts opt-in behind
   * `?includeTotal=true`, and `listOrganizationsQuerySchema` carries no such
   * field — counting unconditionally would make every page pay for a number
   * most callers never read.
   */
  async list(command: ListOrganizationsCommand): Promise<OrganizationCollection> {
    const limit = Math.min(command.limit, LIST_LIMIT_MAX);
    const page = await this.organizations.find({
      userId: command.userId,
      limit,
      cursor: command.cursor,
    });

    const last = page.rows.at(-1);
    return {
      data: [...page.rows],
      pagination: {
        // A cursor only when there is a next page AND a row to build it from.
        // `hasMore` cannot be true on an empty page — it is derived from
        // reading more rows than were asked for — so the second test is
        // unreachable rather than defensive, and it is what makes the type
        // check without an assertion.
        nextCursor:
          page.hasMore && last !== undefined
            ? encodeListCursor({ createdAt: last.createdAt, id: last.id })
            : null,
        hasMore: page.hasMore,
        limit,
      },
    };
  }

  /**
   * `GET /api/v1/organizations/:id` — the organisation this session is acting
   * in, and only that one.
   *
   * The path id is asserted against the resolved tenant first (D4), so the read
   * below is keyed on an id the guard authorised rather than on one the caller
   * chose. `findUniqueOrThrow` would be wrong: a null row inside a tenant
   * transaction on a resolved membership means the organisation went away
   * between the guard's query and this one, and 404 is the honest answer to
   * that rather than a 500.
   */
  async read(ctx: TenantContext, pathId: string): Promise<OrganizationResponse> {
    assertPathIsActiveTenant(ctx, pathId);

    const organization = await withTenantTransaction(this.base, ctx.organizationId, (tx) =>
      tx.organization.findUnique({
        where: { id: ctx.organizationId },
        select: ORGANIZATION_COLUMNS,
      }),
    );
    if (organization === null) throw notFound();
    return toResponse(organization);
  }

  /**
   * `PATCH /api/v1/organizations/:id` — the name, and nothing else in Phase 2.
   *
   * `updateOrganizationRequestSchema` is a `ZodEffects` whose refinement
   * refuses `{}` (carry-forward ruling 15), so `name` is present by the time
   * this runs — but the inferred type keeps it optional, because a refinement
   * cannot narrow a shape. The check below is therefore a real branch rather
   * than a formality: without it an empty patch would still bump `updatedAt`
   * and write an audit row recording a change of nothing.
   *
   * The before/after values go in the metadata, which `security/audit.md` §5
   * permits: a name is not a sensitive field, and "what did this become" is the
   * whole question a rename audit answers.
   */
  async update(
    ctx: TenantContext,
    pathId: string,
    command: UpdateOrganizationCommand,
  ): Promise<OrganizationResponse> {
    assertPathIsActiveTenant(ctx, pathId);

    const name = command.name;
    if (name === undefined) {
      throw new DomainError(
        ERROR_CODES.VALIDATION_ERROR,
        'Provide at least one field to update.',
        400,
      );
    }

    return withTenantTransaction(this.base, ctx.organizationId, async (tx) => {
      const before = await tx.organization.findUnique({
        where: { id: ctx.organizationId },
        select: { name: true },
      });
      if (before === null) throw notFound();

      const organization = await tx.organization.update({
        where: { id: ctx.organizationId },
        data: { name },
        select: ORGANIZATION_COLUMNS,
      });

      await this.audit.record(tx, {
        organizationId: ctx.organizationId,
        actorType: 'USER',
        actorId: command.userId,
        action: 'ORGANIZATION_UPDATED',
        resourceType: 'Organization',
        resourceId: ctx.organizationId,
        metadata: { field: 'name', before: before.name, after: name },
        ip: command.ip,
        userAgent: command.userAgent,
        requestId: command.requestId,
      });

      return toResponse(organization);
    });
  }

  /**
   * `DELETE /api/v1/organizations/:id` — and through this API it always answers
   * 409.
   *
   * # There is no audit event here, and there cannot be one
   *
   * `AuditEvent.organizationId` references `Organization.id` with
   * `onDelete: Restrict`, so an event about a deletion and the deletion it
   * describes cannot be one transaction **in either order**. Measured as
   * `sentinel_app` on 2026-09-02: with the audit row written first the `DELETE`
   * is refused (`Key is still referenced from table "AuditEvent"`), and with
   * the `DELETE` first the audit row is refused (`Key is not present in table
   * "Organization"`). The full transcript is in `audit.actions.ts`, beside the
   * name that is deliberately absent from that constant.
   *
   * # And therefore 409, always, for anything this API created
   *
   * `create` writes `ORGANIZATION_CREATED` in the transaction that creates the
   * organisation, so every organisation reachable through this endpoint already
   * has audit history and the foreign key refuses to let it go. That is the
   * plan's "deletion fails while audit events exist, by design" reached by the
   * database rather than by a check here — and it means the success path below
   * is unreachable through the public API rather than merely rare. It is
   * written anyway because the alternative is an endpoint that refuses without
   * asking, which would be a policy invented in application code on top of a
   * database that already has one.
   *
   * **The constraint is not weakened and nothing is soft-deleted.**
   * `Organization` has no `deletedAt`, adding one is a schema decision outside
   * this task, and the real purge path is Phase 11's platform admin — which has
   * to dispose of the audit history deliberately, which is exactly the review
   * step `Restrict` exists to force.
   *
   * The message says why, because a refusal that does not say how to succeed
   * generates a support ticket (`api/errors.md` §4).
   */
  async remove(ctx: TenantContext, pathId: string): Promise<void> {
    assertPathIsActiveTenant(ctx, pathId);

    try {
      await withTenantTransaction(this.base, ctx.organizationId, (tx) =>
        tx.organization.delete({ where: { id: ctx.organizationId }, select: { id: true } }),
      );
    } catch (error) {
      if (isForeignKeyViolation(error)) {
        throw new DomainError(
          ERROR_CODES.INVALID_STATE_TRANSITION,
          'This organisation cannot be deleted while it has an audit history. Those events are ' +
            'retained deliberately and are not discarded on request — contact Sentinel support ' +
            'to have the organisation and its records purged.',
          409,
        );
      }
      throw error;
    }
  }
}

/**
 * The columns `organizationResponseSchema` publishes, and no others.
 *
 * Written once and shared by the four reads rather than repeated: `Organization`
 * also carries `requireMfa` and `enforcedEmailDomain`, and a handler that selects
 * columns its response schema does not publish is one whose next reader assumes
 * they are load-bearing (Task 8's L7). One constant also means a column added to
 * the response has one place to be added rather than four.
 */
const ORGANIZATION_COLUMNS = {
  id: true,
  slug: true,
  name: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * The Prisma row, as `organizationResponseSchema` publishes it.
 *
 * Timestamps become ISO strings here rather than at the controller: the wire
 * contract says `isoTimestampSchema`, and a `Date` reaching the serialiser
 * would be formatted to the same characters by accident rather than by
 * decision.
 */
function toResponse(row: {
  id: string;
  slug: string;
  name: string;
  // `OrganizationStatus` (Prisma) and `OrganizationStatus` (contracts) are the
  // same three values, and TypeScript accepts the Prisma row here with no
  // assertion — which is only true while they agree. `enum-parity.spec.ts` is
  // what keeps that so, by cross-checking against `Prisma.dmmf.datamodel.enums`
  // (carry-forward ruling 13). An `as` here would have hidden the divergence
  // instead of failing the build on it.
  status: OrganizationResponse['status'];
  createdAt: Date;
  updatedAt: Date;
}): OrganizationResponse {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
