import { z } from "zod";
import { requireVerifiedUser, ok, fail, enforceRateLimit } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { createApiKey } from "@/lib/apikey";

const schema = z.object({ name: z.string().min(1).max(60).optional() });

// List the current user's API keys (display info only — raw key is never
// retrievable after creation).
export async function GET() {
  try {
    const userId = await requireVerifiedUser();
    const keys = await prisma.apiKey.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      select: { id: true, name: true, prefix: true, revokedAt: true, lastUsedAt: true, createdAt: true },
    });
    return ok({ keys });
  } catch (e) {
    return fail(e);
  }
}

const MAX_ACTIVE_KEYS = 10;

export async function POST(req: Request) {
  try {
    const userId = await requireVerifiedUser();
    const limited = await enforceRateLimit(req, "apikey-create", 5, 60_000);
    if (limited) return limited;
    const body = schema.parse(await req.json());
    // Cap active keys: unbounded creation bloats the table and each key adds
    // its own per-key v1 rate budget.
    const active = await prisma.apiKey.count({ where: { userId, revokedAt: null } });
    if (active >= MAX_ACTIVE_KEYS) return fail(new Error("too-many-keys: revoke one before creating another"));
    const key = await createApiKey(userId, body.name ?? "default");
    return ok({ ...key, note: "copy now — the full key is shown only once" });
  } catch (e) {
    if (e instanceof z.ZodError) return fail(new Error("invalid-input"));
    return fail(e);
  }
}
