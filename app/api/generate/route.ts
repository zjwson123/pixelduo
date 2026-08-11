import { z } from "zod";
import { requireVerifiedUser, ok, fail } from "@/lib/api";
import { checkPrompt } from "@/lib/safety";
import { createGenerationJob } from "@/lib/queue";
import { randomUUID } from "crypto";
import { enforceRateLimit } from "@/lib/api";

const schema = z.object({
  prompt: z.string().min(3).max(2000),
  model: z.enum(["gpt", "seedream", "both"]),
  quality: z.enum(["low", "medium", "high"]).default("medium"),
  count: z.number().int().min(1).max(4).default(1),
  idempotencyKey: z.string().max(128).optional(),
});

export async function POST(req: Request) {
  try {
    const userId = await requireVerifiedUser();
    const body = schema.parse(await req.json());
    const limited = await enforceRateLimit(req, "generate", 20, 60_000);
    if (limited) return limited;
    const safety = checkPrompt(body.prompt);
    if (!safety.ok) return fail(new Error(`blocked:${safety.reason}`));
    const key = body.idempotencyKey || `${userId}:${randomUUID()}`;
    const { job, created } = await createGenerationJob({
      userId,
      model: body.model,
      quality: body.quality,
      count: body.count,
      prompt: body.prompt.trim(),
      idempotencyKey: key,
    });
    return ok({ jobId: job.id, status: job.status, costCredits: job.costCredits, duplicate: !created });
  } catch (e) {
    if (e instanceof z.ZodError) return fail(new Error("invalid-input"));
    return fail(e);
  }
}
