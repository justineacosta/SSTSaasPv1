-- The application connects as a least-privileged role. It is not a superuser
-- and does not have BYPASSRLS, which is the only thing that makes row-level
-- security a real second layer rather than decoration. See ADR-0006.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'sentinel_app') THEN
    CREATE ROLE sentinel_app LOGIN PASSWORD 'sentinel_app_local';
  END IF;
END
$$;

GRANT CONNECT ON DATABASE sentinel TO sentinel_app;
GRANT USAGE ON SCHEMA public TO sentinel_app;

-- Existing objects.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO sentinel_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO sentinel_app;

-- Future objects created by the owner. Without this, every new table would be
-- invisible to the application until someone remembered to grant on it.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO sentinel_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO sentinel_app;

-- ---------------------------------------------------------------------------
-- ADR-0020: the role that owns `user_organizations(text)`, and nothing else.
--
-- `GET /api/v1/organizations` asks a question that spans organisations — which
-- ones does this user belong to — and `Membership` carries FORCE ROW LEVEL
-- SECURITY keyed on `app.organization_id`, which no tenant transaction can set
-- for an organisation you are trying to discover. FORCE binds the table owner
-- too, so a SECURITY DEFINER function only escapes the policy if its owner can
-- bypass RLS.
--
-- Creating a BYPASSRLS role requires superuser, so a migration cannot create it
-- — exactly as with `sentinel_app` above (carry-forward ruling 96). It is a
-- provisioning step performed once per database, out of band, and the migration
-- that creates the function raises a named error if this role is absent.
--
-- NOLOGIN: nothing can connect as it. NOINHERIT: a role granted membership of
-- it does not pick up BYPASSRLS by inheritance, only by an explicit SET ROLE.
-- No password, because there is no login to authenticate.
--
-- It is deliberately granted nothing here. The privileges it needs are on
-- objects the migrations create, so they are granted by the migration that
-- creates the function: USAGE on the schema and SELECT on exactly two tables.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'sentinel_org_lookup') THEN
    CREATE ROLE sentinel_org_lookup NOLOGIN NOINHERIT BYPASSRLS;
  END IF;
END
$$;
