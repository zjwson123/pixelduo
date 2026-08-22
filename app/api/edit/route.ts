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
    const body = schema.parse(await req.json());
    const limited = await enforceRateLimit(req, "edit", 15, 60_000);
    if (limited) return limited;
    const safety = checkPrompt(body.prompt);
    if (!safety.ok) return fail(new Error(`blocked:${safety.reason}`));

    // Store the reference image(s) and get storage key(s)
    const allImages = [body.image, ...(body.extraImages ?? [])];
    // Strip data URL prefix if present
    const cleanedImages = allImages.map((img) => {
      const match = img.match(/^data:image\/[a-z]+;base64,(.+)$/);
      return match ? match[1] : img;
    });

    // Store the primary reference image
    const refKey = newStorageKey("png");
    await getStorage().put(refKey, Buffer.from(cleanedImages[0], "base64"), "image/png");

    const key = body.idempotencyKey || `${userId}:edit:${randomUUID()}`;
    const { job, created } = await createMediaJob({
      userId,
      model: body.model,
      mediaType: "image",
      quality: body.quality,
      count: 1,
      prompt: body.prompt.trim(),
      idempotencyKey: key,
      refImageKey: refKey,
    });
    return ok({ jobId: job.id, status: job.status, costCredits: job.costCredits, duplicate: !created });
  } catch (e) {
    if (e instanceof z.ZodError) return fail(new Error("invalid-input"));
    return fail(e);
  }
}
