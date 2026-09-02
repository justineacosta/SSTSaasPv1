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
   demoted; the API rejects it.
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
   invitation acceptance are both still unwritten — is in
   [`../security/authorization.md`](../security/authorization.md) §4. The operator took the
   decision on 2026-09-02. Adding a cache later is additive, and would put the "invalidated on
   write" clause back into force as a requirement on whoever adds it.

   Proved rather than asserted: `authorization.integration.spec.ts` promotes a member, demotes
   one and removes one, each time over the **same session cookie** with no sign-in in between,
   and asserts the next request reflects it.
5. Removing a member revokes their sessions for that organisation immediately.
