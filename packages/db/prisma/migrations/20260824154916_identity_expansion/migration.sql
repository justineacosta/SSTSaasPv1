-- Phase 2 identity expansion: brute-force state on User, MFA/SSO settings on
-- Organization, the two-lifetime Session model, and four new user-owned tables
-- (MfaFactor, RecoveryCode, VerificationToken, IdentityProviderLink).
--
-- Generated with `prisma migrate dev --create-only` and then hand-edited in
-- three places. Each is recorded below, because the whole reason this file is
-- reviewed as SQL before it is applied (Phase 2 execution protocol §5) is that
-- what Prisma generates here is wrong, or silent, in ways that are invisible
-- from schema.prisma.
--
-- Prisma's generated `/* Warnings: */` header was deleted rather than kept:
-- every warning in it described the generated statements, and all four are
-- resolved by the edits below. Leaving it would have left four false sentences
-- at the top of the file.
--
--
-- EDIT 1 — Session.expiresAt is RENAMED, not dropped and re-added.
--
-- Prisma cannot detect a column rename. It emitted
-- `DROP COLUMN "expiresAt"` + `ADD COLUMN "idleExpiresAt"`, which is data loss
-- wearing a rename's name: in a database with rows the migration would either
-- fail on the NOT NULL or destroy the column's contents.
-- `ALTER TABLE ... RENAME COLUMN` is the correct statement and it is written by
-- hand.
--
-- Measured: "Session" holds 0 rows in the development database at the time of
-- writing, and nothing in Phase 1 ever inserts one. So today this edit changes
-- no outcome at all. That is exactly why it is made now — the habit has to
-- exist before the first table that does hold rows, and forming it while being
-- wrong is free costs nothing. Do not read "harmless today" as "optional".
--
-- Note that `DROP INDEX "Session_userId_expiresAt_idx"` below is still correct
-- after the rename: Postgres rewrites an index's *definition* when a column it
-- covers is renamed, but not the index's own name.
--
--
-- EDIT 2 — the three new NOT NULL Session columns, and what an existing row
-- would get.
--
-- Prisma emitted `status`, `idleExpiresAt` and `absoluteExpiresAt` as NOT NULL
-- with no default, which cannot be applied to a non-empty table at all.
-- `idleExpiresAt` stops being a problem once EDIT 1 makes it a rename — it
-- keeps every existing value. The other two are handled deliberately:
--
--   * `status` is added with a TRANSIENT DEFAULT of 'PENDING_MFA', then the
--     default is dropped. PENDING_MFA is the UNPRIVILEGED state
--     (security/authentication.md §5: it can do nothing but complete MFA), so
--     any pre-existing session is demoted rather than promoted. Defaulting to
--     'ACTIVE' would have silently granted full privilege to every row nobody
--     looked at. The default is then dropped so new inserts must state a status
--     explicitly — matching schema.prisma, where `status` deliberately has no
--     @default for the same reason.
--
--   * `absoluteExpiresAt` is added with a TRANSIENT DEFAULT of now(), then the
--     default is dropped. A pre-existing row therefore becomes immediately past
--     its absolute expiry and forces a re-login. That is the fail-closed
--     direction: the alternative, some invented future date, would extend
--     sessions issued before the absolute lifetime existed as a concept and
--     which were never subject to it.
--
-- Both defaults are dropped in the same migration that adds them. A default
-- left behind would quietly satisfy the NOT NULL for every future insert that
-- forgot the column, which is the failure this pair of statements exists to
-- prevent.
--
--
-- EDIT 3 — deleting statements Prisma emitted about Membership. There were
-- none.
--
-- The Phase 2 plan predicted that generating this migration would emit
-- statements dropping the partial unique index from
-- 20260824153519_membership_partial_unique and re-adding the full
-- `@@unique([organizationId, userId])`, to be deleted by hand here. It did not:
-- the generated file contained ZERO statements mentioning "Membership".
-- Recorded because the prediction is in the plan and a later reader will look
-- for the deletion that never had to happen. The measurement, and everything
-- else about Membership's constraints, lives in that migration — this file
-- touches Membership not at all.
--
--
-- CASCADE, STATED RATHER THAN INFERRED.
--
-- All four new tables reference "User" with ON DELETE CASCADE, which is the
-- opposite of the choice made for "Membership"."userId" in
-- 20260820142200_membership_user_restrict. That is deliberate, and the
-- distinction is one thing: whether the cascade can cross a tenant boundary.
-- A referential-integrity cascade runs inside Postgres's constraint machinery,
-- below both the tenant-scoped client and row-level security, so a Membership
-- cascade let one tenant's user deletion destroy another tenant's rows unseen —
-- hence RESTRICT there. These four tables are single-user-owned and carry no
-- organizationId at all, so there is no second tenant for a cascade to reach.
--
-- BE PRECISE ABOUT WHEN THESE CASCADES ACTUALLY FIRE, because it is rarer than
-- it sounds. "Membership"."userId" is RESTRICT and
-- "Invitation"."invitedByUserId" is RESTRICT too, so a DELETE on "User" RAISES
-- a foreign-key violation for anyone who has ever joined an organisation or
-- sent an invitation — which is every real user of this product. These four
-- cascades therefore only ever fire for the narrow case of a registered account
-- that never joined anything and never invited anyone: an abandoned signup, or
-- a verification that was started and dropped.
--
-- So the honest claim is narrow. CASCADE is a correctness backstop that keeps
-- authentication material from outliving the only account it belongs to in the
-- one case where the row can be deleted at all. It is NOT an account-deletion
-- mechanism: for everybody else the DELETE fails outright and the material is
-- left behind by a failed statement, not carried away by a successful one. Real
-- account deletion has to remove memberships and invitations first, through the
-- tenant-scoped path, and it needs its own design — it does not exist yet and
-- these cascades do not constitute one.
--
-- None of the four is tenant-owned; none gets an RLS policy. They are
-- registered in the deliberately-global list in src/tenant-resources.ts, and
-- `sentinel_app`'s privileges on them are ASSERTED by
-- src/migration.integration.spec.ts rather than granted here — the grants
-- already arrive from the ALTER DEFAULT PRIVILEGES statement in
-- infra/docker/postgres/init/01-app-role.sql, which covers tables created
-- afterwards by the owner role that runs migrations. A GRANT here would be a
-- second, divergent source of truth for the same privileges.

-- CreateEnum
CREATE TYPE "SessionStatus" AS ENUM ('PENDING_MFA', 'ACTIVE');

-- CreateEnum
CREATE TYPE "MfaFactorType" AS ENUM ('TOTP', 'WEBAUTHN');

-- CreateEnum
CREATE TYPE "VerificationPurpose" AS ENUM ('EMAIL_VERIFICATION', 'PASSWORD_RESET');

-- RenameColumn (hand-written: replaces Prisma's DROP COLUMN + ADD COLUMN — EDIT 1)
ALTER TABLE "Session" RENAME COLUMN "expiresAt" TO "idleExpiresAt";

-- DropIndex
DROP INDEX "Session_userId_expiresAt_idx";

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "enforcedEmailDomain" TEXT,
ADD COLUMN     "requireMfa" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "lastSeenAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "mfaCompletedAt" TIMESTAMPTZ(6),
ADD COLUMN     "rememberMe" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "rotatedFromId" TEXT;

-- AlterTable (hand-written: transient defaults, dropped immediately — EDIT 2)
ALTER TABLE "Session" ADD COLUMN     "absoluteExpiresAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "status" "SessionStatus" NOT NULL DEFAULT 'PENDING_MFA';
ALTER TABLE "Session" ALTER COLUMN "absoluteExpiresAt" DROP DEFAULT;
ALTER TABLE "Session" ALTER COLUMN "status" DROP DEFAULT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastLoginAt" TIMESTAMPTZ(6),
ADD COLUMN     "lockedUntil" TIMESTAMPTZ(6);

-- CreateTable
CREATE TABLE "MfaFactor" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "MfaFactorType" NOT NULL,
    "secretEncrypted" TEXT NOT NULL,
    "secretKeyVersion" INTEGER,
    "confirmedAt" TIMESTAMPTZ(6),
    "label" TEXT,
    "lastUsedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MfaFactor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecoveryCode" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "usedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecoveryCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "purpose" "VerificationPurpose" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "consumedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VerificationToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdentityProviderLink" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdentityProviderLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MfaFactor_userId_type_key" ON "MfaFactor"("userId", "type");

-- CreateIndex
CREATE INDEX "RecoveryCode_userId_usedAt_idx" ON "RecoveryCode"("userId", "usedAt");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_tokenHash_key" ON "VerificationToken"("tokenHash");

-- CreateIndex
CREATE INDEX "VerificationToken_userId_purpose_idx" ON "VerificationToken"("userId", "purpose");

-- CreateIndex
CREATE UNIQUE INDEX "IdentityProviderLink_providerId_externalId_key" ON "IdentityProviderLink"("providerId", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "IdentityProviderLink_userId_providerId_key" ON "IdentityProviderLink"("userId", "providerId");

-- CreateIndex
CREATE INDEX "Session_userId_lastSeenAt_idx" ON "Session"("userId", "lastSeenAt" DESC);

-- CreateIndex
CREATE INDEX "Session_absoluteExpiresAt_idx" ON "Session"("absoluteExpiresAt");

-- AddForeignKey
ALTER TABLE "MfaFactor" ADD CONSTRAINT "MfaFactor_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryCode" ADD CONSTRAINT "RecoveryCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationToken" ADD CONSTRAINT "VerificationToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdentityProviderLink" ADD CONSTRAINT "IdentityProviderLink_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
