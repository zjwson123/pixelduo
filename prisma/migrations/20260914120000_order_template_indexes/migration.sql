-- Indexes for read paths that filtered on unindexed columns:
--   Order.userId       — order history, admin order table, account export
--   Template.img       — /api/files thumbnail lookup, once per Explore render
CREATE INDEX "Order_userId_createdAt_idx" ON "Order"("userId", "createdAt");
CREATE INDEX "Template_img_idx" ON "Template"("img");
