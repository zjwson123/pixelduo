import { requireUserId, ok, fail } from "@/lib/api";
import { getActiveJobsForUser } from "@/lib/queue";
import { serveUserUrl } from "@/lib/store";

function serialize(job: Awaited<ReturnType<typeof getActiveJobsForUser>>[number]) {
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
    images: images.map((k) => serveUserUrl(k)),
    error: job.error,
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
    const jobs = await getActiveJobsForUser(userId);
    return ok({ jobs: jobs.map(serialize) });
  } catch (e) {
    return fail(e);
  }
}
