import { z } from "zod";
import { requireVerifiedUser, ok, fail, enforceRateLimit, enforceUserRateLimit, readBodyCapped } from "@/lib/api";
import { routePrompt } from "@/lib/router";

const schema = z.object({
  prompt: z.string().min(3).max(2000),
});

export async function POST(req: Request) {
  try {
    // /api/assistant (the sibling LLM endpoint) requires a verified account —
    // so must this one, or throwaway unverified accounts burn LLM spend.
    const userId = await requireVerifiedUser();
    const limited = await enforceRateLimit(req, "route", 30, 60_000);
    if (limited) return limited;
    // IP rotation must not lift the cap on uncharged LLM spend.
    const userLimited = await enforceUserRateLimit(userId, "route", 30, 60_000);
    if (userLimited) return fail(userLimited);
    const bodyRaw = await readBodyCapped(req, 64 * 1024);
    if ("tooLarge" in bodyRaw) return new Response("payload too large", { status: 413 });
    const body = schema.parse(JSON.parse(bodyRaw.raw));
    const result = await routePrompt(body.prompt);
    return ok(result);
  } catch (e) {
    if (e instanceof z.ZodError) return fail(new Error("invalid-input"));
    return fail(e);
  }
}
