-- Pass 41.
--
-- Money returned by a chargeback/dispute, tracked separately from refunds.
-- Stripe reports `amount_refunded` and a dispute's `amount` independently, so a
-- partial refund plus a partial dispute of the remainder returned the whole
-- payment while neither number alone reached the order price.
ALTER TABLE "Order" ADD COLUMN "disputedAmountUsd" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- Refund/dispute webhooks resolve the order by the provider's payment id inside
-- the webhook transaction; the table grows with every checkout and the lookup
-- was a sequential scan.
CREATE INDEX "Order_providerOrderId_idx" ON "Order"("providerOrderId");
