import { z } from "zod";
import { zodMessage, requireVerifiedUser, ok, fail, enforceRateLimit, enforceUserRateLimit, readBodyCapped } from "@/lib/api";
import { improvePrompt, ASSISTANT_MODELS } from "@/lib/assistant";

const schema = z.object({
  prompt: z.string().max(2000),
  mode: z.enum(["expand", "translate", "style", "inspire"]).default("expand"),
  model: z.enum(ASSISTANT_MODELS.map((m) => m.id) as [string, ...string[]]).default("deepseek"),
});
export async function POST(req: Request) {
  try {
    // Provider LLM calls cost real money — same verified-account gate as the
    // generation routes (unverified accounts can't burn provider cost).
    const userId = await requireVerifiedUser();
    const limited = await enforceRateLimit(req, "assistant", 30, 60_000);
    if (limited) return limited;
    // IP rotation must not lift the cap on uncharged LLM spend.
    const userLimited = await enforceUserRateLimit(userId, "assistant", 30, 60_000);
    if (userLimited) return fail(userLimited);
    // Text-only body — anything beyond a few KB is abuse.
    const bodyRaw = await readBodyCapped(req, 64 * 1024);
    if ("tooLarge" in bodyRaw) return new Response("payload too large", { status: 413 });
    const body = schema.parse(JSON.parse(bodyRaw.raw));
    const result = await improvePrompt(body.prompt, body.mode, body.model);
    return ok(result);
  } catch (e) {
    if (e instanceof z.ZodError) return fail(zodMessage(e));
    return fail(e);
  }
}

export async function GET() {
  return ok({ models: ASSISTANT_MODELS });
}
