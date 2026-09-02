-- Revoke TEMPORARY from PUBLIC, closing the mechanism behind ADR-0021 rather
-- than the single instance ADR-0021 closed.
--
-- WHAT THIS IS FOR. ADR-0021 fixed one `SECURITY DEFINER` function whose
-- `search_path` did not pin `pg_temp` last, after Task 13's review measured a
-- caller shadowing `"Membership"` with a temporary table and reading a real
-- `Organization` row under `BYPASSRLS`. That fix is correct and stays. It is
-- also specific: it protects `user_organizations(text)` and nothing else, and
-- the next definer object written without `pg_temp` last reopens the same hole.
--
-- The precondition for the whole attack is that the calling role can CREATE a
-- temporary relation, which requires TEMPORARY on the database. PostgreSQL
-- grants TEMPORARY (and CONNECT) to PUBLIC on every database by default, and
-- nothing in this repository had revoked it. ADR-0021's consequences named this
-- as "defence in depth against the class rather than the instance" and deferred
-- it to a hardening pass, deliberately, because a database-wide privilege
-- change is its own decision rather than a line in a corrective migration.
-- This is that pass.
--
-- MEASURED BEFORE, on the compose database as `sentinel_app`:
--
--     SELECT has_database_privilege('sentinel_app', current_database(), 'TEMPORARY');
--      has_database_privilege
--     ------------------------
--      t
--
--     CREATE TEMP TABLE "Membership" (...);   -- succeeded
--
-- WHY `current_database()` AND NOT A LITERAL. The database is `sentinel` in
-- compose, and `sentinel` in the Testcontainers harness
-- (`packages/db/src/testing/*.withDatabase('sentinel')`), but a literal here
-- would be a migration that silently does nothing the first time somebody runs
-- it against a differently-named database — and "silently does nothing" is the
-- failure mode this repository keeps finding. `format('%I')` also quotes the
-- identifier correctly, which a string concatenation would not.
--
-- WHAT IT COSTS, AND WHY THAT IS ACCEPTABLE HERE. Any role that legitimately
-- needs temporary tables must now be granted TEMPORARY explicitly. Nothing in
-- this application creates one: the API uses Prisma, which does not, and the
-- only temporary tables ever created in this repository were the probes written
-- by hand to demonstrate the ADR-0021 attack. If a future analytics or
-- reporting path needs them, the grant is one statement and should be made to
-- that role by name rather than by restoring the PUBLIC default.
--
-- IT DOES NOT REPLACE PINNING `pg_temp` LAST. Two independent things must be
-- true, which is the same argument ADR-0006 makes about the tenant-scoped
-- client and row-level security. A superuser, a role granted TEMPORARY for a
-- good reason, or a future managed-database default could all put the
-- capability back; the `search_path` pin is what holds when they do.
-- `migration.integration.spec.ts` asserts both, separately.
--
-- SOUNDNESS ON ITS OWN (carry-forward ruling 1): one REVOKE. No table, no
-- column, no policy, no row. A database that stops here is sound, and one that
-- stops before it has the ADR-0021 pin already in place.

DO $$
BEGIN
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
END
$$;
