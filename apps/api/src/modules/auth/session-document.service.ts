import { Inject, Injectable } from '@nestjs/common';
import type { SessionResponse, TenantContext } from '@sentinel/contracts';
import { ACTIVE_ORGANIZATION_LOOKUP } from './auth.tokens.js';
import type { ActiveOrganizationLookup } from './active-organization.store.js';
import { SessionRepository } from './session.repository.js';

/**
 * The one thing this service needs from `SessionRepository`: the organisation a
 * session says it is currently acting in.
 *
 * `UserPrincipal` carries `userId` and `sessionId` and nothing else
 * (`packages/contracts/src/principal.ts`), deliberately — carry-forward ruling
 * 16 keeps it constructed rather than parsed, and Task 7's ruling E keeps the
 * authentication guard out of tenant resolution. So the column has to be read
 * here, from the session the guard already vouched for.
 */
export interface ActiveOrganizationSource {
  findById(sessionId: string): Promise<{ activeOrganizationId: string | null } | null>;
}

/**
 * `GET /api/v1/auth/session` — the document the permission-aware frontend reads
 * and nothing else.
 *
 * # `permissions` IS NOW REAL, AND IT IS STILL EMPTY ON EVERY SESSION THAT EXISTS
 *
 * Task 12 replaced the hard-coded `[]` with the set `TenantContextGuard`
 * resolved for this request. The value is no longer a stub — and it is still
 * `[]` for every session this phase can create, because the set is empty
 * exactly when no tenant resolved, and nothing writes
 * `Session.activeOrganizationId` until Task 13. **The observable behaviour of
 * this endpoint has not changed; what changed is why.** A reader of this file,
 * or of a captured response, must not take an empty array as evidence that
 * resolution ran and found nothing.
 *
 * It is read off `request.tenant` rather than recomputed. The guard has already
 * done the query, and a second one here could disagree with the answer the same
 * request was authorised against.
 *
 * An unresolved tenant reports `[]` — not an error, and not a partial set. That
 * covers all three of "no organisation chosen", "not a member" and
 * "organisation suspended", and the last is the one worth stating: a member of
 * a suspended organisation may do nothing in it, so an *effective* permission
 * set of nothing is the accurate report rather than a diminished one. This
 * endpoint is `@AuthenticatedOnly()`, so none of the three refuses the request
 * — the caller still gets their own session document.
 *
 * Inventing a placeholder — `['project.read']`, or a wildcard — would be a lie
 * the frontend would believe and act on, and `api/conventions.md`'s contract
 * discipline means `check:openapi` would pin the shape of that lie. An empty
 * array is also the fail-closed direction: a UI that hides everything it cannot
 * prove the user may do is a UI that shows too little, and the API is what
 * actually prevents anything (`CLAUDE.md` rule 3).
 *
 * # `entitlements` is `{}` because billing is Phase 5
 *
 * `sessionResponseSchema` types it as an open record precisely so Phase 5 can
 * fill it without a breaking wire change. Same reasoning as above: a guessed
 * set of keys is a shape pinned before anything can populate it.
 *
 * # `activeOrganization` is implemented for real, and today it always resolves
 * to `null`
 *
 * Nothing in Phase 2 writes `Session.activeOrganizationId` until Task 13, so
 * every session this phase can create carries `null` and the lookup below never
 * runs. It is built now rather than stubbed because an unimplemented lookup is
 * one Task 13 has to *discover* is missing, and it would discover it as a
 * `null` indistinguishable from "this user has not chosen an organisation".
 *
 * **The lookup is not a plain `findUnique`, and `active-organization.store.ts`
 * has the measurement.** `Organization` carries `FORCE ROW LEVEL SECURITY`
 * keyed on `id`, and the API's Prisma client connects as `sentinel_app`, so a
 * read without `app.organization_id` set returns zero rows for every
 * organisation that exists. It goes through `withTenantTransaction`.
 *
 * # It is not a serialisation of `Principal`
 *
 * `sessionResponseSchema` deliberately omits `sessionId` (carry-forward ruling
 * 16's note on it): a session identifier has no business being readable by a
 * script running in the page, and a client that has one will eventually put it
 * in a URL.
 */
@Injectable()
export class SessionDocumentService {
  constructor(
    @Inject(SessionRepository) private readonly sessions: ActiveOrganizationSource,
    @Inject(ACTIVE_ORGANIZATION_LOOKUP) private readonly organizations: ActiveOrganizationLookup,
  ) {}

  /**
   * `tenant` is what `TenantContextGuard` resolved for this request, or
   * `undefined` when it resolved nothing.
   *
   * A parameter rather than a second lookup, and required rather than optional:
   * `exactOptionalPropertyTypes` aside, a caller that may omit it is a caller
   * who can silently report an empty permission set for a member who has one.
   * The controller passes `request.tenant` and there is nothing else to pass.
   */
  async forPrincipal(
    principal: { userId: string; sessionId: string },
    tenant: TenantContext | undefined,
  ): Promise<SessionResponse> {
    const session = await this.sessions.findById(principal.sessionId);
    const organizationId = session?.activeOrganizationId ?? null;

    return {
      userId: principal.userId,
      activeOrganization:
        organizationId === null ? null : await this.organizations.find(organizationId),
      // Sorted, because `permissions` is a set and a response is a sequence:
      // an unstable order would make two identical documents differ, which
      // breaks byte comparison in tests and cache validation in clients.
      permissions: tenant === undefined ? [] : [...tenant.permissions].sort(),
      // Phase 5. An open record, so filling it is additive.
      entitlements: {},
    };
  }
}
