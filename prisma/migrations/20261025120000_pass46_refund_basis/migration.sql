-- Pass 46.
--
-- Two accounting holes in the refund/dispute accumulator:
--
-- 1. Stripe reports ONE dispute object per event, carrying only THAT dispute's
--    amount. `disputedAmountUsd` was written with GREATEST(), i.e. as if every
--    delivery were a re-delivery of one cumulative dispute. A charge can carry
--    more than one dispute (the issuer refiles under another reason code, or
--    bundles several charges), and then two withdrawals of $25 never summed to
--    the $49.99 price: neither alone promoted the order to a full return, so the
--    credits and the paid tier survived money that had all been taken back.
--    The markers make each distinct dispute count exactly once while still
--    letting the same dispute be re-delivered (created/updated/funds_withdrawn).
ALTER TABLE "Order" ADD COLUMN "disputedAdjustments" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- 2. Promotion compared the money returned against Order.amountUsd, the LIST
--    price. A checkout the operator discounted (the documented goodwill flow —
--    a Stripe coupon or customer credit) collects less than the list price, so a
--    dispute or refund of the ENTIRE charge returned 100% of what was captured
--    while the accumulator stayed below the list price: money gone, credits and
--    tier retained. The collected amount is recorded at fulfillment time from
--    the provider's own total (Stripe amount_total; Paddle's net subtotal, which
--    is what the merchant receives). Null for orders fulfilled before this
--    column existed and for the mock provider, where the list price is the only
--    known basis.
ALTER TABLE "Order" ADD COLUMN "collectedAmountUsd" DOUBLE PRECISION;
