import { z } from "zod";
import { zodMessage, requireVerifiedUser, ok, fail, enforceRateLimit, enforceUserRateLimit, readBodyCapped } from "@/lib/api";
import { checkPrompt } from "@/lib/safety";
import { createMediaJob } from "@/lib/queue";
import { getStorage, newStorageKey } from "@/lib/storage";
import { enabledVideoModelIds, getModel, getVideoModels, modelEnum } from "@/lib/model-registry";
import { randomUUID } from "crypto";

const VIDEO_MODEL_IDS = enabledVideoModelIds();

// Loose sanity bound — the real gate is each model's durationSecRange below.
// Derived from the registry so a future longer-duration model needs no route edit.
const VIDEO_DURATION_MAX = getVideoModels().reduce(
  (max, m) => Math.max(max, m.durationSecRange?.max ?? 0),
  15,
);

const schema = z.object({
  // min(1) not min(3): 2-char Chinese prompts ("小狗") are provider-valid and
  // were rejected with a bare "invalid-input". trim() keeps whitespace-only
  // prompts out. max(4000): Ark documents no hard text cap for Seedance — only
  // a soft "≤500 中文字" quality suggestion — so 2000 needlessly rejected long
  // narrative prompts; a provider rejection past creation refunds the hold.
  // The public /api/v1 contract stays at 3–2000.
  prompt: z.string().trim().min(1).max(4000),
  model: z.enum(modelEnum(VIDEO_MODEL_IDS)).default(VIDEO_MODEL_IDS[0] ?? "seedance"),
  duration: z.number().int().min(2).max(VIDEO_DURATION_MAX).default(5),
  // For image-to-video models: reference image as base64 (nullish — some
  // clients send explicit null when unset)
  image: z.string().min(100).max(2_000_000).nullish(),
  idempotencyKey: z.string().max(128).optional(),
});

// One 2M-char base64 image is the legal maximum (~2MB of JSON).
const VIDEO_MAX_BYTES = 4 * 1024 * 1024;

export async function POST(req: Request) {
  try {
    const userId = await requireVerifiedUser();
    // Rate limit before parsing the body: req.json() buffers the whole
    // request, so an unthrottled parse is a memory-exhaustion vector.
    const limited = await enforceRateLimit(req, "video", 10, 60_000);
    if (limited) return limited;
    const userLimited = await enforceUserRateLimit(userId, "video", 10, 60_000);
    if (userLimited) return fail(userLimited);
    const bodyRaw = await readBodyCapped(req, VIDEO_MAX_BYTES);
    if ("tooLarge" in bodyRaw) return new Response("payload too large", { status: 413 });
    const body = schema.parse(JSON.parse(bodyRaw.raw));
    const safety = checkPrompt(body.prompt);
    if (!safety.ok) return fail(new Error(`blocked:${safety.reason}`));

    // Pure i2v models need a first frame; seedance-style models accept one optionally
    if (getModel(body.model)?.requiresImageInput && !body.image) {
      return fail(new Error(`invalid-input: ${body.model} requires a reference image`));
    }
    // Provider-enforced duration range (Seedance 2.0 rejects <4s) — check
    // before pre-authing credits
    const range = getModel(body.model)?.durationSecRange;
    if (range && (body.duration < range.min || body.duration > range.max)) {
      return fail(new Error(`invalid-input: ${body.model} supports ${range.min}-${range.max}s videos`));
    }

    let refImageKey: string | undefined;
    if (body.image) {
      // Data URL prefix, if present. The class must accept "+" (image/svg+xml):
      // with `[a-z]+` such a payload did not match, so the whole data URL was
      // decoded as base64 into garbage bytes and stored as the reference frame.
      const cleaned = body.image.match(/^data:image\/[\w.+-]+;base64,(.+)$/i)?.[1] ?? body.image;
      // Same orphan-guard as /api/edit: the upload precedes job creation, so
      // every path that doesn't attach the key to a job must delete it.
      const storage = getStorage();
      refImageKey = newStorageKey("png");
      let result: Awaited<ReturnType<typeof createMediaJob>>;
      try {
        await storage.put(refImageKey, Buffer.from(cleaned, "base64"), "image/png");
        const key = body.idempotencyKey || `${userId}:video:${randomUUID()}`;
        result = await createMediaJob({
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
      } catch (e) {
        await storage.delete(refImageKey).catch(() => undefined);
        throw e;
      }
      if (!result.created) {
        await storage.delete(refImageKey).catch(() => undefined);
      }
      return ok({ jobId: result.job.id, status: result.job.status, costCredits: result.job.costCredits, duplicate: !result.created });
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
    });
    return ok({ jobId: job.id, status: job.status, costCredits: job.costCredits, duplicate: !created });
  } catch (e) {
    if (e instanceof z.ZodError) return fail(zodMessage(e));
    return fail(e);
  }
}
