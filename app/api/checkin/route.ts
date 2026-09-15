import { requireVerifiedUser, ok, fail, enforceRateLimit, enforceUserRateLimit } from "@/lib/api";
import { dailyCheckin } from "@/lib/ledger";
import { prisma } from "@/lib/prisma";

export async function POST(req: Request) {
  try {
    const userId = await requireVerifiedUser();
    // Idempotent per day, so this is not a correctness guard — it keeps a
    // scripted loop from hammering the DB (the middleware cap is per-IP and
    // per-instance, so IP rotation lifts it).
    const limited = await enforceRateLimit(req, "checkin", 10, 60_000);
    if (limited) return limited;
    const userLimited = await enforceUserRateLimit(userId, "checkin", 10, 60_000);
    if (userLimited) return fail(userLimited);
    const result = await dailyCheckin(userId);
    const user = await prisma.user.findUnique({ where: { id: userId } });
    return ok({ ...result, balance: user?.credits ?? 0 });
  } catch (e) {
    return fail(e);
  }
}
