-- A won dispute (or reinstated funds) must leave the order's disputed total.
-- Stripe reports the movement twice (`charge.dispute.funds_reinstated` and
-- `charge.dispute.closed` with status `won`); the markers make the subtraction
-- happen exactly once.
ALTER TABLE "Order" ADD COLUMN "disputeReinstatements" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
