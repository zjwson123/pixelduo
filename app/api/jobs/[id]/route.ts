import { requireUserId, ok, fail } from "@/lib/api";
import { getJobForUser } from "@/lib/queue";
import { serveUserUrl } from "@/lib/store";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const userId = await requireUserId();
    const job = await getJobForUser(userId, id);
    if (!job) return fail(new Error("job-not-found"));
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
        mediaType: job.mediaType,
        isEdit: Boolean(job.refImageKey),
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
