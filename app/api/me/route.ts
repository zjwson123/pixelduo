import { requireUserId, ok, fail, enforceUserRateLimit } from "@/lib/api";
import { prisma } from "@/lib/prisma";

export async function GET() {
  try {
    const userId = await requireUserId();
    const limited = await enforceUserRateLimit(userId, "me", 120, 60_000);
    if (limited) return fail(limited);
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        credits: true,
        plan: true,
        planRenewsAt: true,
        emailVerified: true,
        totpEnabled: true,
        createdAt: true,
      },
    });
    if (!user) return fail(new Error("user-not-found"));
    return ok({ user });
  } catch (e) {
    return fail(e);
  }
}
