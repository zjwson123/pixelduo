-- Pass 53.
--
-- reclaimStoredArtifact (lib/queue.ts) counts Image rows by (jobId, url) every
-- time a failed/lease-lost attempt's stored objects are reclaimed, and every
-- time a superseded extend clip is retired. Image was indexed on
-- (userId, createdAt) and (userId, url) only, so both were sequential scans
-- over a table that grows one row per delivered asset.
CREATE INDEX "Image_jobId_idx" ON "Image"("jobId");
