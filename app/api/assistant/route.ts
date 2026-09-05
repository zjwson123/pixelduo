import { z } from "zod";
import { requireVerifiedUser, ok, fail, enforceRateLimit } from "@/lib/api";
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
    await requireVerifiedUser();
    const limited = await enforceRateLimit(req, "assistant", 30, 60_000);
    if (limited) return limited;
    const body = schema.parse(await req.json());
    const result = await improvePrompt(body.prompt, body.mode, body.model);
    return ok(result);
  } catch (e) {
    if (e instanceof z.ZodError) return fail(new Error("invalid-input"));
    return fail(e);
  }
}

export async function GET() {
  return ok({ models: ASSISTANT_MODELS });
}
