import { requireUserId, ok, fail } from "@/lib/api";
import { getJobForUser } from "@/lib/queue";
import { serveUserUrl } from "@/lib/store";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  try {
    const userId = await requireUserId();
    const job = await getJobForUser(userId, params.id);
    if (!job) return fail(new Error("job-not-found"));
    const images = (JSON.parse(job.images) as string[]);
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
