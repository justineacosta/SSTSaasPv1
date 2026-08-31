import { Inject, Injectable } from '@nestjs/common';
import type { SessionResponse } from '@sentinel/contracts';
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
 * # `permissions` IS GENUINELY EMPTY, AND THAT IS NOT A PLACEHOLDER
 *
 * D8. There is no role-assignment machinery until Task 12: `Membership.roleId`
 * exists, `PERMISSIONS` exists, `@RequirePermission()` exists as metadata no
 * guard reads, and **nothing anywhere computes an effective permission set**.
 * The honest value today is `[]`, and it is what this returns.
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

  async forPrincipal(principal: { userId: string; sessionId: string }): Promise<SessionResponse> {
    const session = await this.sessions.findById(principal.sessionId);
    const organizationId = session?.activeOrganizationId ?? null;

    return {
      userId: principal.userId,
      activeOrganization:
        organizationId === null ? null : await this.organizations.find(organizationId),
      // See the class docblock. NOT a placeholder, and not to be filled with a
      // guess: Task 12 owns computing this from the caller's `Membership` and
      // `Role`, and until then the effective permission set really is empty.
      permissions: [],
      // Phase 5. An open record, so filling it is additive.
      entitlements: {},
    };
  }
}
