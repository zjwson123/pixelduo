-- The credit invariant, enforced by the database instead of by convention.
--
-- `User.credits == SUM(CreditGrant.remaining)` and `0 <= remaining <= amount`
-- were application-only rules. Every writer honours them (spend decrements,
-- refund increments by exactly what was consumed, revoke/expiry zero, clawback
-- decrements, every grant is created with remaining = amount) — but nothing
-- refused a writer that did not, and a single arithmetic slip (a consumption
-- refunded twice is the obvious one: remaining would exceed amount and the
-- balance would be minted from nothing) corrupted the ledger silently and
-- permanently: the balance then disagrees with the rows forever, `runExpiry`
-- throws insufficient-credits for that account on every sweep, and the operator
-- has no signal until a customer notices.
--
-- NOT VALID is deliberate and is the whole reason this migration is safe to
-- deploy: it applies to every future INSERT and UPDATE immediately, but does
-- NOT scan the existing rows, so a table that already contains a violating row
-- (a manual insert, a benchmark, a bug fixed long ago) does not fail the
-- migration that introduces the rule. Existing violations are repaired with
-- scripts/repair-credit-invariant.ts, after which the operator can promote the
-- constraint to a full guarantee with
--   ALTER TABLE "CreditGrant" VALIDATE CONSTRAINT "CreditGrant_remaining_range";
-- (documented in docs/deploy.md; it is a plain scan of one table, and it fails
-- loudly if something is still broken rather than silently accepting it).
ALTER TABLE "CreditGrant"
  ADD CONSTRAINT "CreditGrant_remaining_range"
  CHECK ("remaining" >= 0 AND "remaining" <= "amount") NOT VALID;
