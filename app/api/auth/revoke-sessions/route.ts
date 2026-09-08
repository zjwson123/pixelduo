import { requireUserId, ok, fail } from "@/lib/api";
import { prisma } from "@/lib/prisma";

// Revoke every active session for the current user (including this one).
export async function POST() {
  try {
    const userId = await requireUserId();
    // "Revoke everything" must include API keys — they are a parallel
    // credential that outlives JWT session versions.
    await prisma.$transaction([
      prisma.user.update({
        where: { id: userId },
        data: { sessionVersion: { increment: 1 } },
      }),
      prisma.apiKey.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
    return ok({ revoked: true });
  } catch (e) {
    return fail(e);
  }
}
