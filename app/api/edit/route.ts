import { z } from "zod";
import { requireVerifiedUser, ok, fail, enforceRateLimit } from "@/lib/api";
import { checkPrompt } from "@/lib/safety";
import { createMediaJob } from "@/lib/queue";
import { getStorage, newStorageKey } from "@/lib/storage";
import { getImageModels, modelEnum } from "@/lib/model-registry";
import { randomUUID } from "crypto";

const EDITABLE_MODEL_IDS = getImageModels()
  .filter((m) => m.supportsImageInput)
  .map((m) => m.id);

const schema = z.object({
  prompt: z.string().min(3).max(2000),
  model: z.enum(modelEnum(EDITABLE_MODEL_IDS)).default("gpt"),
  quality: z.enum(["low", "medium", "high"]).default("medium"),
  // Reference image as base64 (data URL or raw base64)
  image: z.string().min(100).max(2_000_000), // up to ~2MB base64
  // For multi-image editing (image-input capable models): up to 9 images
  extraImages: z.array(z.string().min(100).max(2_000_000)).max(8).optional(),
  idempotencyKey: z.string().max(128).optional(),
});

export async function POST(req: Request) {
  try {
    const userId = await requireVerifiedUser();
    // Rate limit before parsing the body: req.json() buffers the whole
    // request (base64 images make edit bodies the largest surface).
    const limited = await enforceRateLimit(req, "edit", 15, 60_000);
    if (limited) return limited;
    const body = schema.parse(await req.json());
    const safety = checkPrompt(body.prompt);
    if (!safety.ok) return fail(new Error(`blocked:${safety.reason}`));

    // Store the reference image(s) and get storage key(s)
    const allImages = [body.image, ...(body.extraImages ?? [])];
    // Strip data URL prefix if present
    const cleanedImages = allImages.map((img) => {
      const match = img.match(/^data:image\/[a-z]+;base64,(.+)$/);
      return match ? match[1] : img;
    });

    // Store the primary reference image. The write happens BEFORE job creation
    // (the job row must not reference a file that may not exist yet), so any
    // path that doesn't hand the key to a job must delete it — otherwise a
    // zero-credit account fills storage at the route rate limit for free.
    const refKey = newStorageKey("png");
    const storage = getStorage();
    let result: Awaited<ReturnType<typeof createMediaJob>>;
    try {
      await storage.put(refKey, Buffer.from(cleanedImages[0], "base64"), "image/png");
      const key = body.idempotencyKey || `${userId}:edit:${randomUUID()}`;
      result = await createMediaJob({
        userId,
        model: body.model,
        mediaType: "image",
        quality: body.quality,
        count: 1,
        prompt: body.prompt.trim(),
        idempotencyKey: key,
        refImageKey: refKey,
      });
    } catch (e) {
      await storage.delete(refKey).catch(() => undefined);
      throw e;
    }
    if (!result.created) {
      // Idempotent replay returns the ORIGINAL job (with its own ref image);
      // the fresh upload is an orphan — clean it up.
      await storage.delete(refKey).catch(() => undefined);
    }
    return ok({ jobId: result.job.id, status: result.job.status, costCredits: result.job.costCredits, duplicate: !result.created });
  } catch (e) {
    if (e instanceof z.ZodError) return fail(new Error("invalid-input"));
    return fail(e);
  }
}
