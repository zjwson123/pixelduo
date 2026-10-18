import { z } from "zod";
import { enforceRateLimit, errorResponse, fail, ok, parseJsonBody, readBodyCapped, zodMessage, tooLarge } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import { authenticateApiKey } from "@/lib/apikey";
import { checkPrompt } from "@/lib/safety";
import { createGenerationJob, createMediaJob } from "@/lib/queue";
import { enabledImageModelIds, enabledVideoModelIds, getVideoModels, getModel, modelEnum } from "@/lib/model-registry";
import { randomUUID } from "crypto";

// Loose sanity bound — each model's durationSecRange is the real gate below.
const VIDEO_DURATION_MAX = getVideoModels().reduce(
  (max, m) => Math.max(max, m.durationSecRange?.max ?? 0),
  15,
);

const schema = z.object({
  // trim before the floor (pass 34): min(3) counts untrimmed characters, so
  // "   " passed validation, cleared checkPrompt, and created a real
  // generation/video job that bills the provider for empty content. Same rule
  // as /api/route's sibling schema and the four routes that always had it.
  prompt: z.string().trim().min(3).max(2000),
  model: z.enum(modelEnum([...enabledImageModelIds(), "both", ...enabledVideoModelIds()])).default("gpt"),
  quality: z.enum(["low", "medium", "high"]).default("medium"),
  n: z.number().int().min(1).max(4).default(1),
  duration: z.number().int().min(2).max(VIDEO_DURATION_MAX).default(5),
});

export const dynamic = "force-dynamic";

// Public API: create an image or video generation job.
// Auth via `Authorization: Bearer pd_live_…`
export async function POST(req: Request) {
  try {
    // The per-key bucket below can only key on a VALID key, so it never bounds
    // the invalid-key flood — and the two lookups authenticateApiKey costs
    // (ApiKey by hash, User by PK) ran before any limiter at all. Same shape as
    // /api/files: an address leg first, for the caller with no credential yet.
    //
    // It is a FLOOD bound, not the account's budget (pass 39): at 60/min it was
    // spent before authentication, so one key bursting its 20/min and being
    // refused still spent the shared egress bucket and refused every OTHER key
    // behind the same NAT for the rest of the window. 600/min keeps the
    // invalid-key lookup bound (10 lookups/s) while the per-key 20/min ceiling
    // is the actual caller limit.
    const ipLimited = await enforceRateLimit(req, "v1-create", 600, 60_000);
    if (ipLimited) return ipLimited;
    const auth = await authenticateApiKey(req);
    if (!auth) return errorResponse({ ok: false, error: "unauthorized" }, { status: 401 });
    if (!auth.emailVerified) {
      return errorResponse({ ok: false, error: "verify-email-required" }, { status: 403 });
    }
    // Client-supplied retry key: without it, a caller that times out on the
    // 202 and retries pre-auths credits and pays the provider a second time.
    // Namespaced per user inside scopedIdempotencyKey (lib/queue.ts).
    const suppliedKey = (req.headers.get("idempotency-key") ?? "").trim().slice(0, 120);
    const idemSuffix = suppliedKey || randomUUID();
    const r = await rateLimit(`apikey:${auth.keyId}`, 20, 60_000);
    if (!r.ok) {
      return errorResponse(
        { ok: false, error: "rate-limited" },
        {
          status: 429,
          headers: {
            "Retry-After": String(r.retryAfterSec),
            "RateLimit-Limit": "20",
            "RateLimit-Remaining": String(r.remaining ?? 0),
          },
        },
      );
    }
    const bodyRaw = await readBodyCapped(req, 64 * 1024);
    if ("tooLarge" in bodyRaw) return tooLarge();
    const body = schema.parse(parseJsonBody(bodyRaw.raw));
    const safety = checkPrompt(body.prompt);
    if (!safety.ok) {
      return errorResponse({ ok: false, error: `blocked:${safety.reason}` }, { status: 400 });
    }

    const model = body.model;
    const isVideo = getModel(model)?.mediaType === "video";

    if (isVideo) {
      // The public API has no image field: pure image-to-video models (i2v)
      // would pre-auth credits and die at the provider with no first frame.
      if (getModel(model)?.requiresImageInput) {
        return errorResponse(
          { ok: false, error: `invalid-input: ${model} requires a first-frame image — use the web app` },
          { status: 400 },
        );
      }
      // Provider-enforced duration range (Seedance 2.0 rejects <4s) — check
      // before pre-authing credits
      const range = getModel(model)?.durationSecRange;
      if (range && (body.duration < range.min || body.duration > range.max)) {
        return errorResponse(
          { ok: false, error: `invalid-input: ${model} supports ${range.min}-${range.max}s videos` },
          { status: 400 },
        );
      }
      const { job, created } = await createMediaJob({
        userId: auth.userId,
        model,
        mediaType: "video",
        quality: "standard",
        count: 1,
        prompt: body.prompt.trim(),
        idempotencyKey: `api:${body.model}:${body.n}:${body.duration}:${idemSuffix}`,
        durationSec: body.duration,
      });
      return ok({ jobId: job.id, status: job.status, costCredits: job.costCredits, duplicate: !created });
    }

    // Legacy models
    if (model === "gpt" || model === "seedream" || model === "both") {
      const { job, created } = await createGenerationJob({
        userId: auth.userId,
        model,
        quality: body.quality,
        count: body.n,
        prompt: body.prompt.trim(),
        idempotencyKey: `api:${body.model}:${body.n}:${body.duration}:${idemSuffix}`,
      });
      return ok({ jobId: job.id, status: job.status, costCredits: job.costCredits, duplicate: !created });
    }

    // New image models
    const { job, created } = await createMediaJob({
      userId: auth.userId,
      model,
      mediaType: "image",
      quality: body.quality,
      count: body.n,
      prompt: body.prompt.trim(),
      idempotencyKey: `api:${body.model}:${body.n}:${body.duration}:${idemSuffix}`,
    });
    return ok({ jobId: job.id, status: job.status, costCredits: job.costCredits, duplicate: !created });
  } catch (e) {
    if (e instanceof z.ZodError) return fail(zodMessage(e));
    return fail(e);
  }
}
