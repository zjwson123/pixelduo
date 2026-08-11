import { requireVerifiedUser, ok, fail } from "@/lib/api";
import { dailyCheckin } from "@/lib/ledger";
import { prisma } from "@/lib/prisma";

export async function POST() {
  try {
    const userId = await requireVerifiedUser();
    const result = await dailyCheckin(userId);
    const user = await prisma.user.findUnique({ where: { id: userId } });
    return ok({ ...result, balance: user?.credits ?? 0 });
  } catch (e) {
    return fail(e);
  }
}
