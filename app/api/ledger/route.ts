import { requireUserId, ok, fail, enforceUserRateLimit } from "@/lib/api";
import { prisma } from "@/lib/prisma";

export async function GET() {
  try {
    const userId = await requireUserId();
    // Per-account, like the sibling reads: the middleware's per-IP bucket is
    // per-instance and IP rotation lifts it.
    const limited = await enforceUserRateLimit(userId, "ledger-list", 60, 60_000);
    if (limited) return fail(limited);
    // Explicit select: the row also carries `actorId`, the operator who caused
    // an ADMIN clawback. Returning every column handed an ordinary user another
    // account's primary key (the acting admin's) — the only place in the API
    // where a cross-account identifier leaked (pass 43). `refId` is nulled for
    // unattributed admin rows, where it names the operator rather than a job or
    // order the user could recognize.
    const rows = await prisma.ledgerEntry.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: {
        id: true,
        type: true,
        creditsDelta: true,
        balanceAfter: true,
        refType: true,
        refId: true,
        note: true,
        createdAt: true,
      },
    });
    const entries = rows.map((e) => (e.refType === "admin" ? { ...e, refId: null } : e));
    return ok({ entries });
  } catch (e) {
    return fail(e);
  }
}
