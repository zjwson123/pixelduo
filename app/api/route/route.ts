import { z } from "zod";
import { enforceLlmDailyLimit, enforceUserRateLimit, fail, ok, parseJsonBody, readBodyCapped, requireVerifiedUser, zodMessage, tooLarge } from "@/lib/api";
import { routePrompt } from "@/lib/router";

const schema = z.object({
  // trim before the floor: min(3) counts UNTRIMMED characters, so "   " passed
  // validation and was forwarded verbatim — a billed DeepSeek completion for
  // zero user content, at the 30 calls/min this route allows. Every sibling
  // prompt schema trims (generate/edit/video/assistant); this one and the v1
  // route were the two that missed it (pass 34).
  prompt: z.string().trim().min(3).max(2000),
});

export async function POST(req: Request) {
  try {
    // /api/assistant (the sibling LLM endpoint) requires a verified account —
    // so must this one, or throwaway unverified accounts burn LLM spend.
    const userId = await requireVerifiedUser();
    // Account-keyed, and the only leg: see enforceUserRateLimit.
    const userLimited = await enforceUserRateLimit(userId, "route", 30, 60_000);
    if (userLimited) return fail(userLimited);
    const bodyRaw = await readBodyCapped(req, 64 * 1024);
    if ("tooLarge" in bodyRaw) return tooLarge();
    const body = schema.parse(parseJsonBody(bodyRaw.raw));
    // Shared with /api/assistant: alternating the two cannot double the budget,
    // and a malformed request is rejected before it spends a call.
    const dailyLimited = await enforceLlmDailyLimit(userId);
    if (dailyLimited) return fail(dailyLimited);
    const result = await routePrompt(body.prompt);
    return ok(result);
  } catch (e) {
    if (e instanceof z.ZodError) return fail(zodMessage(e));
    return fail(e);
  }
}
