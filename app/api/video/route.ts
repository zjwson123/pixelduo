import { z } from "zod";
import { requireVerifiedUser, ok, fail, enforceRateLimit } from "@/lib/api";
import { checkPrompt } from "@/lib/safety";
import { createMediaJob } from "@/lib/queue";
import { getStorage, newStorageKey } from "@/lib/storage";
import { randomUUID } from "crypto";

const schema = z.object({
  prompt: z.string().min(3).max(2000),
  model: z.enum(["seedance", "wan-t2v", "wan-i2v"]).default("wan-t2v"),
  duration: z.number().int().min(2).max(15).default(5),
  // For image-to-video models: reference image as base64
  image: z.string().min(100).max(2_000_000).optional(),
  idempotencyKey: z.string().max(128).optional(),
});

export async function POST(req: Request) {
  try {
    const userId = await requireVerifiedUser();
    const body = schema.parse(await req.json());
    const limited = await enforceRateLimit(req, "video", 10, 60_000);
    if (limited) return limited;
    const safety = checkPrompt(body.prompt);
    if (!safety.ok) return fail(new Error(`blocked:${safety.reason}`));

    // If image-to-video model requires an image, validate it's present
    if (body.model === "wan-i2v" && !body.image) {
      return fail(new Error("invalid-input: wan-i2v requires a reference image"));
    }

    let refImageKey: string | undefined;
    if (body.image) {
      const cleaned = body.image.match(/^data:image\/[a-z]+;base64,(.+)$/)?.[1] ?? body.image;
      refImageKey = newStorageKey("png");
      await getStorage().put(refImageKey, Buffer.from(cleaned, "base64"), "image/png");
    }

    const key = body.idempotencyKey || `${userId}:video:${randomUUID()}`;
    const { job, created } = await createMediaJob({
      userId,
      model: body.model,
      mediaType: "video",
      quality: "standard",
      count: 1,
      prompt: body.prompt.trim(),
      idempotencyKey: key,
      durationSec: body.duration,
      refImageKey,
    });
    return ok({ jobId: job.id, status: job.status, costCredits: job.costCredits, duplicate: !created });
  } catch (e) {
    if (e instanceof z.ZodError) return fail(new Error("invalid-input"));
    return fail(e);
  }
}
