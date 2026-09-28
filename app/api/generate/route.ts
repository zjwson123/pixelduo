import { z } from "zod";
import { zodMessage, requireVerifiedUser, ok, fail, enforceRateLimit, enforceUserRateLimit, readBodyCapped } from "@/lib/api";
import { checkPrompt } from "@/lib/safety";
import { createGenerationJob, createMediaJob } from "@/lib/queue";
import { enabledImageModelIds, modelEnum } from "@/lib/model-registry";
import { randomUUID } from "crypto";

const schema = z.object({
  prompt: z.string().trim().min(1).max(2000),
  model: z.enum(modelEnum([...enabledImageModelIds(), "both"])).default("gpt"),
  quality: z.enum(["low", "medium", "high"]).default("medium"),
  count: z.number().int().min(1).max(4).default(1),
  idempotencyKey: z.string().max(128).optional(),
});

// Text-only body — anything beyond a few KB is abuse.
const GENERATE_MAX_BYTES = 64 * 1024;

export async function POST(req: Request) {
  try {
    const userId = await requireVerifiedUser();
    // One budget, keyed on the account, before the body is parsed (req.json()
    // buffers the whole request, so an unthrottled parse is a memory-exhaustion
    // vector). This used to be an IP-keyed leg at the same 20/min, charged
    // first — see enforceUserRateLimit in lib/api.ts for why that leg is gone.
    const limited = await enforceUserRateLimit(userId, "generate", 20, 60_000);
    if (limited) return fail(limited);
    const bodyRaw = await readBodyCapped(req, GENERATE_MAX_BYTES);
    if ("tooLarge" in bodyRaw) return new Response("payload too large", { status: 413 });
    const body = schema.parse(JSON.parse(bodyRaw.raw));
    const safety = checkPrompt(body.prompt);
    if (!safety.ok) return fail(new Error(`blocked:${safety.reason}`));
    const key = body.idempotencyKey || `${userId}:${randomUUID()}`;

    // Legacy models (gpt/seedream/both) use the old path
    if (body.model === "gpt" || body.model === "seedream" || body.model === "both") {
      const { job, created } = await createGenerationJob({
        userId,
        model: body.model,
        quality: body.quality,
        count: body.count,
        prompt: body.prompt.trim(),
        idempotencyKey: key,
      });
      return ok({ jobId: job.id, status: job.status, costCredits: job.costCredits, duplicate: !created });
    }

    // New models use the media job path
    const { job, created } = await createMediaJob({
      userId,
      model: body.model,
      mediaType: "image",
      quality: body.quality,
      count: body.count,
      prompt: body.prompt.trim(),
      idempotencyKey: key,
    });
    return ok({ jobId: job.id, status: job.status, costCredits: job.costCredits, duplicate: !created });
  } catch (e) {
    if (e instanceof z.ZodError) return fail(zodMessage(e));
    return fail(e);
  }
}
