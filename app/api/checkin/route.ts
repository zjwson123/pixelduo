import { requireVerifiedUser, ok, fail, enforceUserRateLimit } from "@/lib/api";
import { dailyCheckin } from "@/lib/ledger";
import { prisma } from "@/lib/prisma";

export async function POST() {
  try {
    const userId = await requireVerifiedUser();
    // Idempotent per day, so this is not a correctness guard — it keeps a
    // scripted loop from hammering the DB. Keyed on the ACCOUNT and nothing
    // else: the per-IP leg it used to carry first meant one verified account
    // could hold `checkin:<egress>` full with junk requests and refuse the
    // daily check-in to every neighbour behind the same NAT (see
    // enforceUserRateLimit).
    const limited = await enforceUserRateLimit(userId, "checkin", 10, 60_000);
    if (limited) return fail(limited);
    const result = await dailyCheckin(userId);
    const user = await prisma.user.findUnique({ where: { id: userId } });
    return ok({ ...result, balance: user?.credits ?? 0 });
  } catch (e) {
    return fail(e);
  }
}
