import { requireUserId, ok, fail } from "@/lib/api";
import { prisma } from "@/lib/prisma";

export async function GET() {
  try {
    const userId = await requireUserId();
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        credits: true,
        plan: true,
        planRenewsAt: true,
        emailVerified: true,
        createdAt: true,
      },
    });
    if (!user) return fail(new Error("user-not-found"));
    return ok({ user });
  } catch (e) {
    return fail(e);
  }
}
