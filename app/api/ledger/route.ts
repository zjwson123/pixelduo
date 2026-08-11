import { requireUserId, ok, fail } from "@/lib/api";
import { prisma } from "@/lib/prisma";

export async function GET() {
  try {
    const userId = await requireUserId();
    const entries = await prisma.ledgerEntry.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return ok({ entries });
  } catch (e) {
    return fail(e);
  }
}
