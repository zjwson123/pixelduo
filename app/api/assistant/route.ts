import { z } from "zod";
import { enforceUserRateLimit, fail, ok, parseJsonBody, readBodyCapped, requireVerifiedUser, zodMessage } from "@/lib/api";
import { improvePrompt } from "@/lib/assistant";

const schema = z.object({
  // min(1): an empty prompt is still a billed provider completion, so the 30
  // calls/min this route allows must each cost the caller some content. The
  // sibling /api/route has always required min(3).
  prompt: z.string().trim().min(1).max(2000),
  mode: z.enum(["expand", "translate", "style", "inspire"]).default("expand"),
});
export async function POST(req: Request) {
  try {
    // Provider LLM calls cost real money — same verified-account gate as the
    // generation routes (unverified accounts can't burn provider cost).
    const userId = await requireVerifiedUser();
    // Account-keyed, and the only leg: see enforceUserRateLimit. The per-IP leg
    // it used to carry let one account refuse the assistant to its neighbours.
    const userLimited = await enforceUserRateLimit(userId, "assistant", 30, 60_000);
    if (userLimited) return fail(userLimited);
    // Text-only body — anything beyond a few KB is abuse.
    const bodyRaw = await readBodyCapped(req, 64 * 1024);
    if ("tooLarge" in bodyRaw) return new Response("payload too large", { status: 413 });
    const body = schema.parse(parseJsonBody(bodyRaw.raw));
    const result = await improvePrompt(body.prompt, body.mode);
    return ok(result);
  } catch (e) {
    if (e instanceof z.ZodError) return fail(zodMessage(e));
    return fail(e);
  }
}
