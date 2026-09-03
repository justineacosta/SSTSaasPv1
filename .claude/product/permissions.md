# Permission matrix

Canonical mapping of system roles to permissions. The machine-readable source of truth is
`packages/contracts/src/permissions.ts`; **this table and that file must agree**, and a test
asserts it.

**As of Task 12 there is a third copy and it is the one that decides.** The seeded
`Role` / `Permission` / `RolePermission` rows are what `TenantContextGuard` expands to build
an effective permission set — reading the constant instead would make those rows decorative
and a drift invisible. `pnpm db:seed` builds them *from* the constant, and
`authorization.integration.spec.ts` asserts the seeded rows expand to exactly
`ROLE_PERMISSIONS` for all seven roles, so the three agree or a test fails.

Enforcement design: [`../security/authorization.md`](../security/authorization.md).

Legend: `Y` granted · `-` not granted · `P` granted only for projects explicitly shared

| Permission | OWNER | ADMIN | SECURITY_LEAD | MEMBER | VIEWER | AUDITOR | GUEST |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| `organization.read` | Y | Y | Y | Y | Y | Y | Y |
| `organization.update` | Y | Y | - | - | - | - | - |
| `organization.delete` | Y | - | - | - | - | - | - |
| `organization.manage_members` | Y | Y | - | - | - | - | - |
| `organization.manage_roles` | Y | Y | - | - | - | - | - |
| `project.read` | Y | Y | Y | Y | Y | Y | P |
| `project.create` | Y | Y | Y | Y | - | - | - |
| `project.update` | Y | Y | Y | - | - | - | - |
| `project.delete` | Y | Y | - | - | - | - | - |
| `asset.read` | Y | Y | Y | Y | Y | Y | P |
| `asset.create` | Y | Y | Y | Y | - | - | - |
| `asset.update` | Y | Y | Y | Y | - | - | - |
| `asset.delete` | Y | Y | Y | - | - | - | - |
| `asset.verify_ownership` | Y | Y | Y | - | - | - | - |
| `scope.read` | Y | Y | Y | Y | Y | Y | P |
| `scope.update` | Y | Y | Y | - | - | - | - |
| `scan.read` | Y | Y | Y | Y | Y | Y | P |
| `scan.create` | Y | Y | Y | Y | - | - | - |
| `scan.cancel` | Y | Y | Y | Y | - | - | - |
| `scan.create_aggressive` | Y | Y | Y | - | - | - | - |
| `finding.read` | Y | Y | Y | Y | Y | Y | P |
| `finding.create` | Y | Y | Y | Y | - | - | - |
| `finding.update` | Y | Y | Y | Y | - | - | - |
| `finding.triage` | Y | Y | Y | Y | - | - | - |
| `finding.accept_risk` | Y | Y | Y | - | - | - | - |
| `finding.delete` | Y | Y | - | - | - | - | - |
| `evidence.read` | Y | Y | Y | Y | Y | **-** | P |
| `evidence.upload` | Y | Y | Y | Y | - | - | - |
| `evidence.delete` | Y | Y | Y | - | - | - | - |
| `engagement.read` | Y | Y | Y | Y | Y | Y | P |
| `engagement.create` | Y | Y | Y | - | - | - | - |
| `engagement.update` | Y | Y | Y | Y | - | - | - |
| `engagement.delete` | Y | Y | - | - | - | - | - |
| `report.read` | Y | Y | Y | Y | Y | Y | P |
| `report.create` | Y | Y | Y | Y | - | - | - |
| `report.download` | Y | Y | Y | Y | Y | Y | P |
| `apikey.read` | Y | Y | Y | - | - | Y | - |
| `apikey.create` | Y | Y | - | - | - | - | - |
| `apikey.revoke` | Y | Y | - | - | - | - | - |
| `webhook.read` | Y | Y | Y | - | - | Y | - |
| `webhook.create` | Y | Y | - | - | - | - | - |
| `webhook.update` | Y | Y | - | - | - | - | - |
| `webhook.delete` | Y | Y | - | - | - | - | - |
| `integration.read` | Y | Y | Y | Y | Y | Y | - |
| `integration.manage` | Y | Y | - | - | - | - | - |
| `notification.manage` | Y | Y | Y | Y | Y | Y | Y |
| `audit.read` | Y | Y | - | - | - | **Y** | - |
| `billing.read` | Y | Y | - | - | - | Y | - |
| `billing.manage` | Y | - | - | - | - | - | - |

## Notes on the deliberate oddities

**`AUDITOR` has `audit.read` but not `evidence.read`.** A compliance reviewer must prove
that testing happened and that findings were remediated and verified. They rarely need to
see the vulnerability detail itself, and evidence frequently contains customer secrets and
PII. Least privilege says separate them. An auditor who genuinely needs evidence is granted
`VIEWER` alongside, as a deliberate act.

**`MEMBER` lacks `finding.accept_risk`.** Accepting a risk is a business decision with
compliance weight, not a triage action. It requires `SECURITY_LEAD` or above.

**`MEMBER` lacks `scan.create_aggressive`.** Potentially disruptive testing is a separate
decision from routine scanning.

**`billing.manage` is `OWNER` only.** `ADMIN` can run the organisation but cannot change
what it costs or cancel it.

**`GUEST` is project-scoped.** Every `P` is additionally gated on an explicit project grant;
a guest with no grants sees nothing.

## Invariants

1. An organisation always has **at least one `OWNER`**. The last owner cannot be removed or
   demoted; the API rejects it with **422 `INVALID_STATE_TRANSITION`**.

   **Enforced since Phase 2 Task 14, by a row lock rather than by a count.**
   `PATCH` and `DELETE` on `/api/v1/organizations/{id}/members/{membershipId}` each open a
   transaction, take `SELECT id FROM "Organization" WHERE id = $1 FOR UPDATE` as their first
   statement, and count the live `ACTIVE` `OWNER` memberships inside that lock. A count taken
   outside it enforces nothing: two transactions demoting the two remaining owners each count
   under their own snapshot, each see two, and both commit —
   `apps/api/src/modules/memberships/last-owner.integration.spec.ts` runs exactly that against
   real Postgres and measures the organisation ending with **zero** owners, which is what makes
   the locked version's green tick mean something.

   The mechanism is a lock and not a constraint because there is no declarative form: "at least
   one row matching X exists" is not a row-level predicate, so a CHECK constraint cannot express
   it, and a trigger inherits the same snapshot problem the naive count has. `SERIALIZABLE`
   would close it and was rejected — it aborts one transaction with `40001`, which needs a retry
   loop, and an unhandled `40001` is a 500 on a routine role change.

   An `INVITED` membership holding `OWNER` does not count, and neither does a removed one.
   **Every future writer of `Membership` must take the same lock** — Task 15's invitation
   acceptance took it, and is the third — because a writer outside the serialisation reopens the
   race for everyone. `lockOrganization` is exported from `membership.service.ts` for exactly
   that reason rather than being reimplemented per caller.

2. A custom role can hold **only permissions its creator holds**.
3. An API key can hold **only a subset of its creator's permissions**, and never
   `organization.delete`, `organization.manage_roles`, `billing.manage`, or `apikey.create`.
4. Changing a member's role takes effect on their **next request**.

   **As of Phase 2 Task 12 this holds because there is no permission cache.** The invariant
   was written expecting one, invalidated on write rather than expired on a timer; what
   shipped reads `Membership`, its `Role` and the seeded `RolePermission` rows on every
   request that names an organisation, so the transaction that follows a role change is the
   one that observes it. The reasoning — a cache satisfies this only for as long as every
   future writer remembers to invalidate it, and Task 14's role change and Task 15's
   invitation acceptance were both unwritten when it was taken; both are written now, and
   both read the membership fresh — is in
   [`../security/authorization.md`](../security/authorization.md) §4. The operator took the
   decision on 2026-09-02. Adding a cache later is additive, and would put the "invalidated on
   write" clause back into force as a requirement on whoever adds it.

   Proved rather than asserted: `authorization.integration.spec.ts` promotes a member, demotes
   one and removes one, each time over the **same session cookie** with no sign-in in between,
   and asserts the next request reflects it. Phase 2 Task 14 added the same assertion over the
   *shipped* role-change endpoint: `memberships.integration.spec.ts` promotes a `VIEWER` to
   `ADMIN` and then reads the member list over that member's own unchanged cookie, which a
   `VIEWER` could not have done a moment earlier.

   **`security/authorization.md` §4's no-minting-authority rule now has two enforcement points,
   and the first is the role change.** A role may only be granted if every permission it carries
   is one the actor already holds — so an `ADMIN`, who holds `organization.manage_roles` but not
   `organization.delete`, cannot promote anybody to `OWNER`. Refused with 403
   `PERMISSION_DENIED` naming the first permission the actor lacks. It is a comparison of
   permission **sets**, deliberately, and not a role ranking: a ranking is a second model of
   authority beside this table and it drifts the first time a permission moves between roles.

   **The second is removal**, added in Task 14's fix round: an actor may not remove a member
   whose role carries a permission the actor does not hold, so `organization.manage_members`
   alone does not let an `ADMIN` remove an `OWNER` (403 `PERMISSION_DENIED`, naming
   `organization.delete`). It is the same helper and the same set comparison. Enforcing the rule
   on the `PATCH` only left it one-directional — an `ADMIN` could not mint an `OWNER` and could
   evict one, irreversibly, since the evicted owner cannot restore themselves and no `ADMIN` can
   promote a replacement. `OWNER` removing `OWNER`, `ADMIN` removing `ADMIN`, and self-removal at
   any role are equal or subset comparisons and pass.

   **Self-removal is supported and is not an accident.** A member may remove their own
   membership; the last-owner invariant refuses the sole owner walking out (422), and the same
   call revokes their sessions for that organisation while leaving their account and their
   sessions elsewhere intact. It is stated in the route's OpenAPI description so a client does
   not have to infer it.
5. Removing a member revokes their sessions for that organisation immediately.

   **Enforced since Phase 2 Task 14.** `DELETE
   /api/v1/organizations/{id}/members/{membershipId}` soft-deletes the membership and then calls
   `SessionService.revokeAllForUserInOrganization`, which filters on
   `Session.activeOrganizationId` — so a consultant removed from one organisation keeps the
   sessions pointed at the others, and keeps the one pointed at none. That narrowing is a
   control, not an optimisation: a member whose every session was revoked would hold a valid
   credential that no endpoint answers, including `POST /api/v1/auth/logout`, which is the one
   that ends it. Both directions are asserted in
   `apps/api/src/modules/memberships/memberships.integration.spec.ts`.

   **The revocation runs after the transaction commits, and the removal does not depend on it.**
   There is no permission cache (see invariant 4), so `TenantContextGuard` re-reads the
   membership on every request naming an organisation and answers 404 the moment the row is
   soft-deleted. What the revocation adds is that the session itself is dead rather than merely
   powerless. Revoking inside the transaction would sign out a member whose removal then rolled
   back, which is the failure that has no compensating layer.

   **A switch racing the removal cannot leave a session pointed there, and the ordering alone
   was not what made that true.** `Session.activeOrganizationId` is written by
   `POST /api/v1/auth/switch-org` and by nothing else; signing in creates sessions with a null
   active organisation. But that endpoint reads the membership, *then* calls `rotate`, which
   **inserts a new `Session` row** — and `revokeAllForUserInOrganization` is one `updateMany`
   whose predicate is evaluated at execution time, so it cannot revoke a row that does not exist
   yet. An earlier version of this paragraph argued from the resolver's `deletedAt: null`
   predicate that no such session could be minted. That was measured false: with a 2 s delay
   instrumented between the read and the rotation, the switch answered 200 and left a live,
   `ACTIVE`, un-revoked session pointed at the organisation the member had just been removed
   from, which `GET /api/v1/auth/session` then answered 200 for with that organisation's `id`,
   `slug` and `name`. It is carry-forward ruling 82's shape — writing first and revoking after is
   necessary and not sufficient.

   What makes the invariant hold is the second read: `OrganizationSwitchService` re-resolves the
   membership **after** `rotate` returns, and revokes the session it has just issued when that
   read no longer resolves. Either the insert precedes the revocation and is swept by it, or it
   follows and the re-read observes the removal; there is no third ordering. It is
   `login.service.ts`'s `credentialStillCurrent` applied to membership instead of to a password
   hash, and it is the equivalent `session.service.ts` records against this path. The decision is
   held by `apps/api/src/modules/auth/organization-switch.service.spec.ts`.

   The compensating layer is worth stating separately, because it is what bounded the defect
   while it stood: authority is re-read per request rather than carried in the session, so every
   *guarded* route answered 404 for that session throughout and no tenant data was reachable
   through it. What the re-read stops is the session existing at all.
