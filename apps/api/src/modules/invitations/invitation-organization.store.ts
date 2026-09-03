import { withTenantTransaction } from '@sentinel/db';

/**
 * The base Prisma client, named through the function that consumes it.
 *
 * `Parameters<typeof withTenantTransaction>[0]` rather than a type import of
 * `PrismaClient`: `@sentinel/db/unscoped` is fenced by `no-restricted-imports`
 * and the rule does not distinguish a type-only import from a value one. The
 * same derivation `user-organizations.store.ts` uses, for the same reason.
 *
 * Note that this file never opens a tenant transaction — see the docblock
 * below. `withTenantTransaction` is imported for its type alone.
 */
export type TenantTransactionBase = Parameters<typeof withTenantTransaction>[0];

/** "Which organisation does the invitation with this token hash belong to?" */
export interface InvitationOrganizationLookup {
  find(tokenHash: string): Promise<string | null>;
}

/**
 * The raw shape `invitation_organization_by_token_hash(text)` returns: one
 * column, one row at most.
 */
interface OrganizationIdRow {
  readonly organizationId: string | null;
}

/**
 * ADR-0022, AND THE SECOND QUERY IN THIS PRODUCT THAT RUNS OUTSIDE A TENANT
 * TRANSACTION.
 *
 * # Why it is not `prisma.invitation.findUnique({ where: { tokenHash } })`
 *
 * That returns `null` for every invitation ever sent. `Invitation` carries
 * `ENABLE`/`FORCE ROW LEVEL SECURITY` with the policy
 * `"organizationId" = current_setting('app.organization_id', true)`
 * (`20260820121229_row_level_security`), the API connects as `sentinel_app`,
 * which has neither `SUPERUSER` nor `BYPASSRLS`, and **the person accepting an
 * invitation is a member of nothing** — `Session.activeOrganizationId` is null
 * for them, `TenantContextGuard` resolves no organisation, and
 * `withTenantTransaction` has no id to `SET LOCAL`. The invitation row is what
 * names the organisation, so the handler cannot open the transaction that would
 * let it read the row that would tell it which transaction to open.
 *
 * Measured against the compose Postgres as `sentinel_app`, one transaction,
 * looking a row up by its `tokenHash`:
 *
 *     no app.organization_id set   -> 0 rows
 *     owning organisation set      -> 1 row
 *     a different organisation set -> 0 rows
 *
 * So this is a `SECURITY DEFINER` function owned by `sentinel_org_lookup`, the
 * `NOLOGIN NOINHERIT BYPASSRLS` role ADR-0020 provisioned and ADR-0022 widened
 * to a second function. The full argument, the alternatives and the operator's
 * ruling on one-role-per-function are in ADR-0022 and in
 * `20260904020000_invitation_lookup_function/migration.sql`.
 *
 * # What contains the bypass, and what this file must therefore NOT do
 *
 * **The function returns one column and makes no policy decision.** It does not
 * filter on `acceptedAt`, `revokedAt` or `expiresAt`, and it does not look at
 * the invited address. Every one of those is a decision with a status code
 * attached and all of them stay in `InvitationService.accept`, which re-reads
 * the whole row **under ordinary RLS** inside `withTenantTransaction(<the id
 * this returned>)`. Widening this lookup to return the row — or to filter — is
 * the one change that must not be made here: it would move authorization logic
 * inside the single construct in this schema that ignores row-level security.
 *
 * **The organisation id this returns is a routing hint, not a permission.** A
 * caller who supplies a matching hash already holds the credential, and the
 * handler still refuses everything: the row it re-reads is refused if it is
 * consumed, revoked or expired, and refused again if the invited address is not
 * the authenticated caller's (D11). The id alone gets nobody anything.
 *
 * # Why the argument is safe to accept from a request body
 *
 * `tokenHash` is the SHA-256 of a 256-bit `randomBytes` token that exists only
 * in the invited person's inbox (`secret-token.ts`). There is no enumeration to
 * defend against and no oracle: a wrong hash returns `NULL`. Contrast
 * `user_organizations(text)`, whose argument is a user id and whose comment
 * therefore has to insist it comes from the session and never from a path
 * parameter — that warning does not apply here, and the difference is the
 * unguessability of the argument rather than a weaker rule.
 *
 * **The raw token never reaches this file.** The caller hashes it and passes
 * the hash, so a stray log line here could leak a value that is already stored
 * in the row rather than the credential itself.
 *
 * # It runs on the base client, outside any transaction, and that is correct
 *
 * The documented exception, exactly as `user-organizations.store.ts` is: there
 * is no organisation to scope to, which is the question being asked.
 * `security/tenant-isolation.md` records both rather than leaving a reader to
 * infer that the rule has holes.
 */
export function invitationOrganizationLookup(
  base: TenantTransactionBase,
): InvitationOrganizationLookup {
  return {
    find: async (tokenHash: string) => {
      // Parameterised: `$queryRaw` is a tagged template, so the hash is a
      // Prisma placeholder and never string-concatenated. Never
      // `$queryRawUnsafe`.
      //
      // Aliased to `organizationId` because the function's return column is
      // named after the function; a bare `SELECT invitation_organization_by_
      // token_hash(...)` would give the row a key this file would then have to
      // spell twice.
      const rows = await base.$queryRaw<OrganizationIdRow[]>`
        SELECT public.invitation_organization_by_token_hash(${tokenHash}) AS "organizationId"
      `;
      // A scalar function in the select list always yields exactly one row, and
      // its value is NULL when no invitation matched. Both branches are written
      // out rather than chained through `?.` so that "no row at all" — which
      // would mean the function stopped existing — is not silently folded into
      // "no such invitation".
      const row = rows[0];
      if (row === undefined) {
        throw new Error(
          'public.invitation_organization_by_token_hash(text) returned no row. The migration ' +
            '20260904020000_invitation_lookup_function has not been applied to this database.',
        );
      }
      return row.organizationId;
    },
  };
}
