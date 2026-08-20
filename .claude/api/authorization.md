# API authorization

> **Status: Designed. Not Implemented.** Phase 2.
> Model and permission list: [`../security/authorization.md`](../security/authorization.md)
> and [`../product/permissions.md`](../product/permissions.md). This document covers how it
> appears on the wire and how endpoints declare it.

## 1. Declaration

Every route declares its access requirement. There is no implicit default.

```ts
@Get('findings')
@RequirePermission('finding.read')
list(@Ctx() ctx: TenantContext, @Query() q: ListFindingsDto) { ... }

@Post('scans')
@RequirePermission('scan.create')
@RequireEntitlement('maxConcurrentScans')
create(@Ctx() ctx: TenantContext, @Body() dto: CreateScanDto) { ... }

@Get('health/live')
@Public()
live() { ... }
```

A route with no `@RequirePermission`, `@AuthenticatedOnly()`, or `@Public()` **fails an
assertion at application startup**. Missing authorization is a boot crash, not something
discovered in production. A separate test enumerates the route table and asserts every entry
carries an explicit declaration, so the assertion cannot be quietly disabled.

## 2. What the client can see

```
GET /api/v1/auth/session
```

```jsonc
{ "user": { "id": "usr_01J...", "email": "marcus@acme.example", "mfaEnabled": true },
  "organization": { "id": "org_01J...", "name": "Acme Corp", "role": "ADMIN" },
  "permissions": ["organization.read", "project.create", "scan.create", ...],
  "entitlements": { "maxConcurrentScans": 10, "sso": false, ... } }
```

The frontend uses `permissions` to hide or disable affordances
([`../architecture/frontend.md`](../architecture/frontend.md) §5). **This is UX only.** The
list is a mirror of server-side rules, never the rules themselves; every action it permits is
re-authorised server-side, and every action it hides is still rejected if called directly.

Permissions are re-fetched on organisation switch and invalidated on role change, so a demoted
user's UI catches up on their next request rather than at a cache TTL.

## 3. Status codes

| Situation | Status | Code |
|---|---|---|
| Not authenticated | 401 | `UNAUTHENTICATED` |
| Not a member of the target organisation | **404** | `RESOURCE_NOT_FOUND` |
| Member, lacks the permission | 403 | `PERMISSION_DENIED` |
| Resource belongs to another tenant | **404** | `RESOURCE_NOT_FOUND` |
| Organisation suspended | 403 | `ORGANIZATION_SUSPENDED` |
| Entitlement exhausted | 402 | `QUOTA_EXCEEDED` |
| Plan does not include the feature | 402 | `FEATURE_NOT_AVAILABLE` |

**Cross-tenant access returns 404, never 403.** A 403 confirms the resource exists, which lets
an attacker enumerate IDs and map another customer's estate. 403 is reserved for resources
within *your own* organisation whose existence you already know about. This is the single most
important rule in this document, and it applies to every endpoint, every export, every file
download, and every event stream.

## 4. Useful denials

A 403 states which permission is missing and who can grant it, so the user can act rather than
file a ticket:

```jsonc
{ "error": { "code": "PERMISSION_DENIED",
    "message": "You need the \"Accept risk\" permission to close this finding as accepted risk.",
    "details": { "required": "finding.accept_risk", "yourRole": "MEMBER",
                 "rolesWithPermission": ["OWNER", "ADMIN", "SECURITY_LEAD"] },
    "requestId": "req_..." } }
```

We never list *which users* hold the permission — that is organisation membership detail the
caller may not be entitled to. Roles are safe; names are not.

## 5. Resource-level authorization

Permission checks answer "may you do this kind of thing". They do not answer "to this
object". Object-level authorization is structural: every load goes through the tenant-scoped
Prisma client, so a resource in another organisation is simply not found, and project-scoped
principals (`GUEST`) have their project grants applied inside the query rather than checked
afterwards.

There is no code path where a handler receives an unscoped client and remembers to filter. The
scoping is in the client, not the handler
([`../security/tenant-isolation.md`](../security/tenant-isolation.md) §2).

## 6. Testing

The authorization matrix is **generated from the route table**, so a new endpoint gets tests
automatically and an endpoint without them fails CI. For every route: unauthenticated → 401;
authenticated without the permission → 403; authenticated in a different tenant → 404; correct
permission → success. Plus: API key scope intersection, custom roles not exceeding their
creator, last-owner protection, guest project restriction, and immediate effect of revocation
and role change.
