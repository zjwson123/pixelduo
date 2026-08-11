import { z } from "zod";
import { NextResponse } from "next/server";
import { fail, ok } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import { authenticateApiKey } from "@/lib/apikey";
import { checkPrompt } from "@/lib/safety";
import { createGenerationJob } from "@/lib/queue";
import { randomUUID } from "crypto";

const schema = z.object({
  prompt: z.string().min(3).max(2000),
  model: z.enum(["gpt", "seedream", "both"]).default("gpt"),
  quality: z.enum(["low", "medium", "high"]).default("medium"),
  n: z.number().int().min(1).max(4).default(1),
});

export const dynamic = "force-dynamic";

// Public API: create an image generation job. Billed like the web workbench
// (pre-auth credits, worker, settle); auth via `Authorization: Bearer pd_live_…`.
export async function POST(req: Request) {
  try {
    const auth = await authenticateApiKey(req);
    if (!auth) return new NextResponse(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401 });
    if (!auth.emailVerified) {
      return new NextResponse(JSON.stringify({ ok: false, error: "verify-email-required" }), { status: 403 });
    }
    const r = await rateLimit(`apikey:${auth.keyId}`, 20, 60_000);
    if (!r.ok) {
      return NextResponse.json({ ok: false, error: "rate-limited" }, { status: 429, headers: { "Retry-After": String(r.retryAfterSec) } });
    }
    const body = schema.parse(await req.json());
    const safety = checkPrompt(body.prompt);
    if (!safety.ok) {
      return new NextResponse(JSON.stringify({ ok: false, error: `blocked:${safety.reason}` }), { status: 400 });
    }
    const { job, created } = await createGenerationJob({
      userId: auth.userId,
      model: body.model,
      quality: body.quality,
      count: body.n,
      prompt: body.prompt.trim(),
      idempotencyKey: `api:${auth.userId}:${body.prompt.trim()}:${randomUUID()}`,
    });
    return ok({ jobId: job.id, status: job.status, costCredits: job.costCredits, duplicate: !created });
  } catch (e) {
    if (e instanceof z.ZodError) return fail(new Error("invalid-input"));
    return fail(e);
  }
}
