import { z } from "zod";
import { enforceRateLimit, enforceUserRateLimit, fail, ok, parseJsonBody, readBodyCapped, requireVerifiedUser, zodMessage } from "@/lib/api";
import { checkPrompt } from "@/lib/safety";
import { createMediaJob, deliveredVideoSeconds } from "@/lib/queue";
import { getStorage } from "@/lib/storage";
import { saveBase64Image } from "@/lib/store";
import { enabledVideoModelIds, getModel, getVideoModels, modelEnum } from "@/lib/model-registry";
import { upstreamFor } from "@/lib/model-upstream";
import { randomUUID } from "crypto";
import { prisma } from "@/lib/prisma";

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
  // Extend (续写): the finished video job whose clip should be continued.
  // When present, `duration` is the SEGMENT length in seconds (4-15, capped
  // so that source + segment <= 30) and the model/duration semantics switch
  // to Ark's task_type=extend path.
  extendOf: z.string().min(1).max(64).optional(),
  idempotencyKey: z.string().max(128).optional(),
});

// One 2M-char base64 image is the legal maximum (~2MB of JSON).
const VIDEO_MAX_BYTES = 4 * 1024 * 1024;

export async function POST(req: Request) {
  try {
    const userId = await requireVerifiedUser();
    // Account-keyed, before the body is parsed (req.json() buffers the whole
    // request, so an unthrottled parse is a memory-exhaustion vector); the
    // IP-keyed leg it was paired with is gone — see enforceUserRateLimit.
    const limited = await enforceUserRateLimit(userId, "video", 10, 60_000);
    if (limited) return fail(limited);
    const bodyRaw = await readBodyCapped(req, VIDEO_MAX_BYTES);
    if ("tooLarge" in bodyRaw) return new Response("payload too large", { status: 413 });
    const body = schema.parse(parseJsonBody(bodyRaw.raw));
    const safety = checkPrompt(body.prompt);
    if (!safety.ok) return fail(new Error(`blocked:${safety.reason}`));

    // --- Extend (续写) path -------------------------------------------------
    // The deliverable is original + new segment concatenated to one clip;
    // Ark bills and we pre-auth the SEGMENT seconds only. Total is capped at
    // 30s and the segment at the model's own range (4-15s for Seedance 2.0).
    if (body.extendOf) {
      const EXTEND_TOTAL_CAP = 30;
      const src = await prisma.job.findFirst({
        where: { id: body.extendOf, userId, mediaType: "video", status: "done" },
        select: { id: true, model: true, durationSec: true, images: true },
      });
      if (!src) return fail(new Error("invalid-input: extendOf must be one of your finished video jobs"));
      const srcInfo = getModel(src.model);
      if (!srcInfo || upstreamFor(src.model)?.gateway !== "ark") {
        return fail(new Error("invalid-input: only Ark video models can be extended"));
      }
      const srcDur = await deliveredVideoSeconds(src.id);
      if (!srcDur || srcDur < 1) return fail(new Error("invalid-input: source video duration unknown"));
      let srcKey: string | undefined;
      try {
        srcKey = (JSON.parse(src.images) as string[])[0];
      } catch {
        srcKey = undefined;
      }
      if (!srcKey) return fail(new Error("invalid-input: source video file is missing"));
      const srcRange = srcInfo.durationSecRange;
      const segMax = Math.min(srcRange?.max ?? 15, EXTEND_TOTAL_CAP - srcDur);
      const segMin = srcRange?.min ?? 4;
      if (segMax < segMin) {
        return fail(new Error(`invalid-input: source is ${srcDur}s — the ${EXTEND_TOTAL_CAP}s total cap leaves no room to extend`));
      }
      if (body.duration < segMin || body.duration > segMax) {
        return fail(new Error(`invalid-input: extend segment must be ${segMin}-${segMax}s (source ${srcDur}s, total capped at ${EXTEND_TOTAL_CAP}s)`));
      }
      const key = body.idempotencyKey || `${userId}:video:${randomUUID()}`;
      const { job, created } = await createMediaJob({
        userId,
        model: src.model,
        mediaType: "video",
        quality: "standard",
        count: 1,
        prompt: body.prompt.trim(),
        idempotencyKey: key,
        durationSec: body.duration,
        sourceVideoKey: srcKey,
        extendOfJobId: src.id,
      });
      return ok({ jobId: job.id, status: job.status, costCredits: job.costCredits, duplicate: !created });
    }

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
      //
      // And the same rule about the type: it comes from the BYTES, not from the
      // data URL's declared media type. `newStorageKey("png")` + "image/png"
      // labelled a JPEG/WebP first frame a PNG — the label every later reader
      // of this object inherits: /api/files serves it under the sniffed type,
      // the S3 driver records it at PUT (so a presigned URL hands it back), and
      // the worker inlines the bytes to the provider as a data URL whose type
      // is sniffed again (lib/providers refImageDataUrl — the i2v path no
      // longer has Ark fetch this object; this comment used to describe that
      // older mechanism). A label that disagrees with the bytes is a lie every
      // later reader inherits — which is why each hop re-sniffs instead of
      // trusting the claim.
      const storage = getStorage();
      let result: Awaited<ReturnType<typeof createMediaJob>>;
      try {
        refImageKey = await saveBase64Image(cleaned);
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
        if (refImageKey) await storage.delete(refImageKey).catch(() => undefined);
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
