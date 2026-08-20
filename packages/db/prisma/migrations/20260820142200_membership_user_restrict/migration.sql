-- Membership.userId: Cascade -> Restrict (review round 3, Critical).
--
-- Referential-integrity cascades run inside Postgres's own constraint
-- machinery, below both isolation layers: they are not SQL the tenant-scoped
-- client (layer 1) ever issues, and they are not subject to row-level
-- security (layer 2) either. A User -> Membership cascade meant deleting a
-- user who belonged to two organisations destroyed BOTH organisations'
-- Membership rows in a single statement, from either tenant's context.
-- Verified live: over sentinel_app, inside withTenantTransaction(orgA),
-- deleting a user shared with orgB destroyed orgB's membership too, and the
-- delete succeeded silently (no error from either layer).
--
-- RESTRICT makes deleting a User fail while any Membership still references
-- them, in any organisation. Self-serve account deletion is a legitimate
-- Phase 2 flow (DELETE on "User" is deliberately still granted to
-- sentinel_app, unlike Organization), but it must remove the user's
-- memberships one organisation at a time through the normal tenant-scoped
-- path first — which means every removal goes through both isolation layers,
-- rather than happening as a single invisible cascade.
-- DropForeignKey
ALTER TABLE "Membership" DROP CONSTRAINT "Membership_userId_fkey";

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
