# ADR-0021: The cross-organisation lookup function pins `pg_temp` last in its `search_path`

**Status:** Accepted · **Date:** 2026-09-02 · **Supersedes:**
[ADR-0020](ADR-0020-cross-organisation-membership-lookup.md)

## Context

ADR-0020 decided that the caller's own organisation list is read through one `SECURITY DEFINER`
function, `user_organizations(text)`, owned by a dedicated `NOLOGIN NOINHERIT BYPASSRLS` role. That
decision stands and this ADR does not revisit it. What this ADR corrects is one of the four
containment properties ADR-0020 rested on, which was false.

ADR-0020's Decision section claimed:

> **`SET search_path = public`** closes the standard `SECURITY DEFINER` hijack, where a caller
> creates a shadowing object in a schema earlier on the path.

It does not. PostgreSQL searches the **temporary schema first**, ahead of everything, when resolving
*relation* names — unless `pg_temp` appears explicitly in `search_path`, in which case it is
searched at the position written. Listing `public` alone does not exclude `pg_temp`; it leaves it
implicitly first. The documented safe form is to write `pg_temp` **last**.

`sentinel_app` holds `TEMPORARY` on the database — PostgreSQL grants it to `PUBLIC` by default and
nothing in this repository revoked it — so `sentinel_app` can create a temporary relation named
`"Membership"` and grant the definer role `SELECT` on it.

Found by Task 13's adversarial reviewer, and reproduced independently by the orchestrator before
being accepted. Measured as `sentinel_app` against the compose Postgres on 2026-09-02, one session,
no tenant context:

```
CREATE TEMP TABLE "Membership" (id text, "organizationId" text, "userId" text,
                                status text, "deletedAt" timestamptz);
INSERT INTO pg_temp."Membership"
  VALUES ('fake1','org_probe_d2','usr_attacker_not_a_member','ACTIVE',NULL);
GRANT SELECT ON pg_temp."Membership" TO sentinel_org_lookup;

SELECT id, slug, name, status FROM user_organizations('usr_attacker_not_a_member');
      id      |   slug   |   name   | status
--------------+----------+----------+--------
 org_probe_d2 | probe-d2 | Probe D2 | ACTIVE
(1 row)

-- the same role, same session, reading the real table directly:
SELECT count(*) FROM public."Organization";
 count
-------
     0
```

The function joined an **attacker-supplied** `Membership` against the **real**
`public."Organization"` under `BYPASSRLS` and returned a row for a user with no membership — to a
role whose own reads of both tables return nothing. The fixed predicate in the function body did not
help: it was applied faithfully, to the wrong table.

The severity is bounded by reachability. Exploiting this requires arbitrary SQL execution as
`sentinel_app`, and the API offers no such surface — both raw statements in the request path are
parameterised tagged templates, and `sentinel_app` cannot `CREATE` in `public`. So what was broken
was a defence-in-depth property and a written security claim, not a presently reachable
vulnerability. It is worth an ADR anyway, because ADR-0020's argument for accepting a `BYPASSRLS`
object was explicitly a list of four containment properties, and a reader auditing that list would
have been reassured by a false one.

## Decision

`user_organizations(text)` pins **`SET search_path = public, pg_temp`** — `pg_temp` present, and
last.

Migration `20260902130000_organization_lookup_search_path` issues the `ALTER FUNCTION`, carrying the
measured transcript above. The previous migration is left exactly as it was applied, per
carry-forward ruling 2: editing an applied migration breaks `prisma migrate dev` on every existing
clone while `migrate deploy` and `migrate status` do not notice.

`packages/db/src/migration.integration.spec.ts` pins the corrected value, and pins the **rule**
separately from the value — that `pg_temp` is present, and that it is the last entry — so that a
later edit which keeps `pg_temp` but moves it earlier fails with a message naming the actual rule
rather than an equality mismatch. The previous assertion pinned the vulnerable value with a comment
asserting the opposite; a pin is only as good as the value in it.

ADR-0020's other three containment properties are unchanged and were re-checked rather than assumed:
the predicate is fixed in the function body, the bypass is confined to one function owned by a role
that cannot log in and owns nothing else, and `sentinel_app`'s own reads of both tables still return
zero rows.

## Alternatives considered

**`SET search_path = pg_catalog, pg_temp`.** The most conservative form, and what PostgreSQL's own
documentation reaches for. Rejected only because the function body names `public."Membership"` and
`public."Organization"` unqualified and would have to be rewritten to schema-qualify every
reference; `public, pg_temp` achieves the same exclusion with a one-token change to a migration
whose body is already reviewed. Either is correct. If a later migration schema-qualifies the body,
the stricter form becomes free and should be taken.

**Revoke `TEMPORARY` from `PUBLIC` on the database.** Real defence in depth, and it would have
prevented this specific hijack outright. Not taken *here* because it is a database-wide privilege
change affecting every role and every future connection, which deserves its own decision rather than
a line in a corrective migration — and because it is a mitigation for the mechanism rather than a
fix for the function. It is recorded as a residual risk in `security/tenant-isolation.md`. A
deployment hardening pass is the right owner.

**Schema-qualify the body and leave `search_path` alone.** `FROM public."Membership"` resolves
correctly whatever the path. Rejected as the primary fix because it protects this function and
teaches nothing to the next one: the property worth having is a `search_path` that is safe for any
body, and the pinned assertion then guards every future edit rather than only the current text.
Worth doing *in addition*, and the ADR above says so.

**Leave it and document the limitation.** Rejected. The fix is one token, and the claim was written
into four places including a test comment that pinned the vulnerable value.

## Consequences

**ADR-0020 is superseded rather than edited**, per this directory's rule. Its decision — one definer
function, one dedicated `BYPASSRLS` owner — remains the operative one and is not restated here;
readers arriving at ADR-0020 are pointed forward, and its false sentence stays visible in the record
rather than being quietly removed. An ADR that is edited to match what we later learned destroys the
only thing this directory is for.

**The residual is now written down**: `sentinel_app` holds `TEMPORARY`, and the general shape of
this attack applies to any future `SECURITY DEFINER` object that forgets `pg_temp`. There is exactly
one such object today and it is now correct. **Any future one must pin `pg_temp` last**, and the
assertion in `migration.integration.spec.ts` is the pattern to copy — not the equality, the rule.

**This is the second defect ADR-0020's own text produced**, after the two missing `GRANT`s the
implementer measured. Both were found by someone attacking the artefact rather than reading it, and
neither would have been caught by any command in the verification suite. The general lesson is
recorded as a carry-forward ruling: **a security property asserted in prose is a hypothesis until
someone tries to violate it**, and the cheapest time to try is while writing the sentence.
