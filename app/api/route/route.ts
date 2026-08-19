import { z } from "zod";
import { requireUserId, ok, fail, enforceRateLimit } from "@/lib/api";
import { routePrompt } from "@/lib/router";

const schema = z.object({
  prompt: z.string().min(3).max(2000),
});

export async function POST(req: Request) {
  try {
    await requireUserId();
    const limited = await enforceRateLimit(req, "route", 30, 60_000);
    if (limited) return limited;
    const body = schema.parse(await req.json());
    const result = await routePrompt(body.prompt);
    return ok(result);
  } catch (e) {
    if (e instanceof z.ZodError) return fail(new Error("invalid-input"));
    return fail(e);
  }
}
