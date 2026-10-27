import { requireUserId, ok, fail, enforceUserRateLimit, refuseNul } from "@/lib/api";
import { deliveredVideoSeconds, getJobForUser, redactJobError } from "@/lib/queue";
import { serveUserUrl } from "@/lib/store";

// See /api/jobs: 600/min per account clears several polling tabs, and bounds a
// client that loops this route (each call can cost up to 10 queries walking an
// extend chain).
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    // Path params are the sibling leg of pass 25's body/query NUL guards:
    // `/api/jobs/x%00y` decodes to a real U+0000, the Prisma lookup dies with
    // SQLSTATE 22021, and fail() masks that as a 500 plus a captured incident.
    refuseNul(id);
    const userId = await requireUserId();
    const limited = await enforceUserRateLimit(userId, "jobs-get", 600, 60_000);
    if (limited) return fail(limited);
    const job = await getJobForUser(userId, id);
    if (!job) return fail(new Error("job-not-found"));
    let images: string[];
    try {
      images = (JSON.parse(job.images) as unknown[]).filter((k): k is string => typeof k === "string");
      if (!Array.isArray(images)) images = [];
    } catch {
      images = [];
    }
    const served = images.map((k) => serveUserUrl(k));
    return ok({
      job: {
        id: job.id,
        status: job.status,
        model: job.model,
        mediaType: job.mediaType,
        isEdit: Boolean(job.refImageKey),
        quality: job.quality,
        count: job.count,
        prompt: job.prompt,
        costCredits: job.costCredits,
        // Delivered length for extend jobs (original + chained segments) — the
        // client's 30s-cap arithmetic reads this field, not the segment length.
        durationSec: job.extendOfJobId ? await deliveredVideoSeconds(job.id) : job.durationSec,
        images: served,
        // Same read-time mask as /api/jobs — see redactJobError.
        error: redactJobError(job.error),
        createdAt: job.createdAt,
        finishedAt: job.finishedAt,
      },
    });
  } catch (e) {
    return fail(e);
  }
}
