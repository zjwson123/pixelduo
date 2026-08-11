import { requireUserId, ok, fail } from "@/lib/api";
import { prisma } from "@/lib/prisma";

// Revoke every active session for the current user (including this one).
export async function POST() {
  try {
    const userId = await requireUserId();
    await prisma.user.update({
      where: { id: userId },
      data: { sessionVersion: { increment: 1 } },
    });
    return ok({ revoked: true });
  } catch (e) {
    return fail(e);
  }
}
