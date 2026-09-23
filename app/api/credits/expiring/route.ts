import { requireUserId, ok, fail, enforceUserRateLimit } from "@/lib/api";
import { listExpiringCredits } from "@/lib/credits";

export async function GET() {
  try {
    const userId = await requireUserId();
    const limited = await enforceUserRateLimit(userId, "expiring-credits", 60, 60_000);
    if (limited) return fail(limited);
    const expiring = await listExpiringCredits(userId);
    return ok({ expiring });
  } catch (e) {
    return fail(e);
  }
}
