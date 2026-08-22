import { requireUserId, ok, fail } from "@/lib/api";
import { getActiveJobForUser } from "@/lib/queue";
import { serveUserUrl } from "@/lib/store";

// Latest in-flight job for the current user (or null). The workbench calls
// this on mount so navigation / page refresh doesn't lose track of a
// generation that is still running server-side.
export async function GET() {
  try {
    const userId = await requireUserId();
    const job = await getActiveJobForUser(userId);
    if (!job) return ok({ job: null });
    let images: string[];
    try {
      images = JSON.parse(job.images) as string[];
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
        quality: job.quality,
        count: job.count,
        prompt: job.prompt,
        costCredits: job.costCredits,
        images: served,
        error: job.error,
        createdAt: job.createdAt,
        finishedAt: job.finishedAt,
      },
    });
  } catch (e) {
    return fail(e);
  }
}
