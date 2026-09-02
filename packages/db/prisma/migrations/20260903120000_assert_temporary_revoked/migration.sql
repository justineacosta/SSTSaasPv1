-- The previous migration's REVOKE cannot fail. This one makes it fail.
--
-- WHAT WAS WRONG. 20260903090000_revoke_temporary_from_public issues
-- `REVOKE TEMPORARY ON DATABASE <db> FROM PUBLIC` and nothing else. PostgreSQL
-- does not error when a role that is neither the database owner nor a
-- superuser issues `REVOKE ... FROM PUBLIC`: it emits
-- `WARNING: no privileges could be revoked` and the statement SUCCEEDS.
--
-- Measured on 2026-09-03 with that migration's `DO` block run verbatim, as a
-- non-owner role, against a scratch database, under `ON_ERROR_STOP=1`:
--
--     before: t
--     WARNING:  no privileges could be revoked for "m1probe"
--     DO
--     after:  t
--     psql exit: 0
--
-- So on a managed Postgres whose migration role does not own the database —
-- which is the deployment where this control matters most — that migration
-- reports success having changed nothing, and every document asserting the
-- privilege is revoked becomes false at once.
--
-- `current_database()` in the previous migration closes the
-- wrong-database-name variant of "silently does nothing". It does not close the
-- insufficient-privilege variant, and that is the likely one. The comment
-- there names "silently does nothing" as the failure mode it was written to
-- avoid, which is what makes this worth a migration rather than a note.
--
-- WHY A SECOND MIGRATION AND NOT AN EDIT. Carry-forward ruling 2, demonstrated
-- rather than recited: the fix was first written as an edit to the applied
-- migration, and `pnpm db:migrate` then refused with
-- `The migration 20260903090000_revoke_temporary_from_public was modified after
-- it was applied. We need to reset the "public" schema`, exit 1 — a reset this
-- session cannot perform (ruling 3). `prisma migrate status` reported "Database
-- schema is up to date!" and exit 0 throughout, exactly as ruling 2 says it
-- would, so nothing but `migrate dev` would have told anyone. The edit was
-- reverted and the fix moved here.
--
-- WHAT THIS DOES. Re-issues the revoke, which is idempotent and free when the
-- previous migration already took effect, then re-reads the privilege and
-- raises if it survived. A database that reaches the end of this migration has
-- `PUBLIC` without `TEMPORARY`, and one that cannot get there stops with a
-- message naming the cause instead of leaving a security control that
-- everybody believes is applied. Same shape as the `sentinel_org_lookup` guard
-- in 20260902083622_organization_lookup_function.
--
-- SOUNDNESS ON ITS OWN (ruling 1): one REVOKE and one check. No table, no
-- column, no policy, no row.

DO $$
BEGIN
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());

  IF has_database_privilege('public', current_database(), 'TEMPORARY') THEN
    RAISE EXCEPTION
      'PUBLIC still holds TEMPORARY on database %', current_database()
      USING
        DETAIL  = 'REVOKE TEMPORARY ... FROM PUBLIC did not take effect. PostgreSQL does not error when a role that is neither the database owner nor a superuser issues it; it warns and succeeds, so this would otherwise report success having changed nothing.',
        HINT    = 'Run migrations as the database owner or a superuser, or have an operator run: REVOKE TEMPORARY ON DATABASE <db> FROM PUBLIC;',
        ERRCODE = 'insufficient_privilege';
  END IF;
END
$$;
