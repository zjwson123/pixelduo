-- Pass 70.
--
-- Three read paths that run inside other operations' critical sections were
-- sequential scans:
--
-- 1. PaymentEvent(orderId). Both erasure routes delete an account's payment
--    events with `DELETE … WHERE orderId IN (SELECT id FROM "Order" WHERE
--    userId = …)` inside the 60-second erasure transaction, after taking the
--    Order → Job → CreditGrant → User row locks. Unindexed, a large account's
--    erasure scans the whole PaymentEvent table (which has no retention job)
--    while every writer that touches those locks waits; past the 60s ceiling
--    the erasure rolls back and the user cannot delete their account.
--
-- 2. User(createdAt). The admin console's user list is ORDER BY createdAt DESC
--    with skip/take at 60 requests/min.
--
-- 3. User(role). The last-admin invariant (assertAnotherAdminRemains) counts
--    role = 'admin' inside ADMIN_GUARD_LOCK on every admin delete/role change,
--    so the scan is both per-request cost and a serialization point.
CREATE INDEX "PaymentEvent_orderId_idx" ON "PaymentEvent"("orderId");
CREATE INDEX "User_createdAt_idx" ON "User"("createdAt");
CREATE INDEX "User_role_idx" ON "User"("role");
