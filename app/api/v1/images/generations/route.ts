import { z } from "zod";
import { NextResponse } from "next/server";
import { fail, ok, readBodyCapped } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import { authenticateApiKey } from "@/lib/apikey";
import { checkPrompt } from "@/lib/safety";
import { createGenerationJob, createMediaJob } from "@/lib/queue";
import { enabledImageModelIds, enabledVideoModelIds, getModel, modelEnum } from "@/lib/model-registry";
import { randomUUID } from "crypto";

const schema = z.object({
  prompt: z.string().min(3).max(2000),
  model: z.enum(modelEnum([...enabledImageModelIds(), "both", ...enabledVideoModelIds()])).default("gpt"),
  quality: z.enum(["low", "medium", "high"]).default("medium"),
  n: z.number().int().min(1).max(4).default(1),
  duration: z.number().int().min(2).max(15).default(5),
});

export const dynamic = "force-dynamic";

// Public API: create an image or video generation job.
// Auth via `Authorization: Bearer pd_live_…`
export async function POST(req: Request) {
  try {
    const auth = await authenticateApiKey(req);
    if (!auth) return new NextResponse(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401 });
    if (!auth.emailVerified) {
      return new NextResponse(JSON.stringify({ ok: false, error: "verify-email-required" }), { status: 403 });
    }
    // Client-supplied retry key: without it, a caller that times out on the
    // 202 and retries pre-auths credits and pays the provider a second time.
    // Namespaced per user inside scopedIdempotencyKey (lib/queue.ts).
    const suppliedKey = (req.headers.get("idempotency-key") ?? "").trim().slice(0, 120);
    const idemSuffix = suppliedKey || randomUUID();
    const r = await rateLimit(`apikey:${auth.keyId}`, 20, 60_000);
    if (!r.ok) {
      return NextResponse.json(
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
    if ("tooLarge" in bodyRaw) return new Response("payload too large", { status: 413 });
    const body = schema.parse(JSON.parse(bodyRaw.raw));
    const safety = checkPrompt(body.prompt);
    if (!safety.ok) {
      return new NextResponse(JSON.stringify({ ok: false, error: `blocked:${safety.reason}` }), { status: 400 });
    }

    const model = body.model;
    const isVideo = getModel(model)?.mediaType === "video";

    if (isVideo) {
      // The public API has no image field: pure image-to-video models (i2v)
      // would pre-auth credits and die at the provider with no first frame.
      if (getModel(model)?.requiresImageInput) {
        return new NextResponse(
          JSON.stringify({ ok: false, error: `invalid-input: ${model} requires a first-frame image — use the web app` }),
          { status: 400 },
        );
      }
      // Provider-enforced duration range (Seedance 2.0 rejects <4s) — check
      // before pre-authing credits
      const range = getModel(model)?.durationSecRange;
      if (range && (body.duration < range.min || body.duration > range.max)) {
        return new NextResponse(
          JSON.stringify({ ok: false, error: `invalid-input: ${model} supports ${range.min}-${range.max}s videos` }),
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
    if (e instanceof z.ZodError) return fail(new Error("invalid-input"));
    return fail(e);
  }
}
