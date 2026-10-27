import { requireUserId, ok, fail, enforceUserRateLimit } from "@/lib/api";
import { deliveredVideoSeconds, getActiveJobsForUser, redactJobError } from "@/lib/queue";
import { serveUserUrl } from "@/lib/store";

// The workbench polls this every 2.5s per open tab (24/min, plus one
// /api/jobs/[id] per in-flight job), so the ceiling has to clear a few tabs at
// once. It is here because each call costs O(in-flight jobs × extend-chain
// length) queries — deliveredVideoSeconds walks up to 10 jobs per extend job —
// and neither this route nor its [id] sibling had any limit at all, so an
// authenticated client could loop them at wire speed against the database
// serving everyone else.
const JOBS_RATE_LIMIT = 600;
const JOBS_RATE_WINDOW_MS = 60_000;

async function serialize(job: Awaited<ReturnType<typeof getActiveJobsForUser>>[number]) {
  let images: string[];
  try {
    images = (JSON.parse(job.images) as unknown[]).filter((k): k is string => typeof k === "string");
    if (!Array.isArray(images)) images = [];
  } catch {
    images = [];
  }
  return {
    id: job.id,
    status: job.status,
    model: job.model,
    mediaType: job.mediaType,
    isEdit: Boolean(job.refImageKey),
    quality: job.quality,
    count: job.count,
    prompt: job.prompt,
    costCredits: job.costCredits,
    // For an extend job this is the DELIVERED length (original + chained
    // segments), which is what the client's 30s-cap arithmetic needs. It costs
    // one extra query only for the jobs that actually are extend jobs.
    durationSec: job.extendOfJobId ? await deliveredVideoSeconds(job.id) : job.durationSec,
    images: images.map((k) => serveUserUrl(k)),
    // Masked on READ as well as at write time (see redactJobError): the column
    // holds failures recorded before pass 47's write-time mask existed, and
    // those rows are still provider-controlled text.
    error: redactJobError(job.error),
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
  };
}

// All in-flight jobs for the current user (newest first). The workbench
// calls this on mount so navigation / page refresh doesn't lose track of
// generations that are still running server-side.
export async function GET() {
  try {
    const userId = await requireUserId();
    const limited = await enforceUserRateLimit(userId, "jobs-list", JOBS_RATE_LIMIT, JOBS_RATE_WINDOW_MS);
    if (limited) return fail(limited);
    const jobs = await getActiveJobsForUser(userId);
    return ok({ jobs: await Promise.all(jobs.map(serialize)) });
  } catch (e) {
    return fail(e);
  }
}
