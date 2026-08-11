import { requireUserId, ok, fail } from "@/lib/api";
import { listExpiringCredits } from "@/lib/credits";

export async function GET() {
  try {
    const userId = await requireUserId();
    const expiring = await listExpiringCredits(userId);
    return ok({ expiring });
  } catch (e) {
    return fail(e);
  }
}
