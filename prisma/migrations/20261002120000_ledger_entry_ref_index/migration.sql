-- Serve cycleUsageTx's `userId = ? AND refId IN (…) AND type IN (…)` scan.
--
-- That measurement runs once per chunk of job ids inside the payment webhook's
-- interactive transaction (5s Prisma timeout), and without this index each
-- chunk scans the account's entire lifetime ledger: measured 6.3s at 33k cycle
-- jobs and 10.1s at 100k, i.e. a paid renewal that 500s while the provider's
-- retry stream re-runs it. The (userId, createdAt) index cannot serve a refId
-- predicate, and the ordering matters: userId first, so the scan is per-account.
CREATE INDEX "LedgerEntry_userId_refId_idx" ON "LedgerEntry"("userId", "refId");
