-- Superseded storage keys whose deletion failed, so terminal failure and
-- account erasure can still reclaim them (pass 66).
ALTER TABLE "Job" ADD COLUMN "staleArtifacts" JSONB;
