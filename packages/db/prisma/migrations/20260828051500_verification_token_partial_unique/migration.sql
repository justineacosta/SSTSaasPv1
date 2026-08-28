-- One live verification token per (user, purpose), enforced by the database.
--
-- Carry-forward ruling 32, owed since Task 4 and assigned to "the next task that
-- opens a migration". Tasks 6 and 7 opened none; Task 8 opens one, so it is paid
-- here.
--
-- `security/authentication.md` §6 says a token of a given purpose is "invalidated
-- by use or by a newer token". Until this index, the only thing holding that was
-- `TokenService.issue`: an advisory lock on `hashtext('vtk:<userId>:<purpose>')`,
-- a supersede of every row with `consumedAt IS NULL`, and an insert, all in one
-- transaction. That is correct and it is *application* correctness — a writer
-- that inserts into `VerificationToken` without going through that method
-- reintroduces the defect silently, because `@@index([userId, purpose])` is not
-- unique and the database arbitrates nothing.
--
-- Hand-written because Prisma cannot express a partial index in
-- `schema.prisma` and does not see one in either direction (carry-forward ruling
-- 4): it will not create it, and it will not offer to drop it. **Do not "restore"
-- a plain `@@unique([userId, purpose])` in the schema** — that would forbid a
-- user from ever holding two tokens of the same purpose across their whole
-- history, including consumed ones.
--
-- WHAT THIS COSTS IF IT FIRES. The loser of a race becomes a Prisma P2002 that a
-- caller would have to catch. It should never fire for `TokenService.issue`,
-- because the advisory lock serialises the supersede-then-insert pair for one
-- (userId, purpose) — and that is asserted rather than assumed, by the
-- concurrent-issue case in `token.service.integration.spec.ts`.
--
-- This migration is sound on its own: it adds one index and touches nothing else.
-- On a database already holding two live tokens for one pair it would fail rather
-- than corrupt anything, which is the correct direction for an invariant.

-- CreateIndex (hand-written: not expressible in schema.prisma)
CREATE UNIQUE INDEX "VerificationToken_userId_purpose_live_key"
  ON "VerificationToken" ("userId", "purpose")
  WHERE "consumedAt" IS NULL;
