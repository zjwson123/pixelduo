import { z } from "zod";
import { requireAdmin } from "@/lib/admin";
import { zodMessage, ok, fail, readBodyCapped, enforceRateLimit, enforceUserRateLimit } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { adminGrantTx, adminClawbackTx } from "@/lib/ledger";

const schema = z.object({
  delta: z.number().int().min(-1000000).max(1000000).refine((v) => v !== 0, { message: "delta-zero" }),
  note: z.string().min(1).max(200),
});

// Admin credit adjustment: positive = compensation grant (never expires,
// consumed first), negative = clawback (FIFO, free/admin grants first).
// Rate-limited per IP AND per acting admin: with its sibling below this was one
// of only two routes that parsed a body with no limit of its own, and it moves
// up to 1,000,000 credits per request, so a stolen admin session (or a retry
// loop) had no ceiling below the coarse per-IP middleware cap.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const adminId = await requireAdmin();
    const limited = await enforceRateLimit(req, "admin-credits", 30, 60_000);
    if (limited) return limited;
    const adminLimited = await enforceUserRateLimit(adminId, "admin-credits", 30, 60_000);
    if (adminLimited) return fail(adminLimited);
    const bodyRaw = await readBodyCapped(req, 8 * 1024);
    if ("tooLarge" in bodyRaw) return new Response("payload too large", { status: 413 });
    const body = schema.parse(JSON.parse(bodyRaw.raw));
    const user = await prisma.user.findUnique({ where: { id: id }, select: { id: true } });
    if (!user) return fail(new Error("user-not-found"));
    await prisma.$transaction(async (tx) => {
      if (body.delta > 0) await adminGrantTx(tx, user.id, body.delta, body.note, adminId);
      else await adminClawbackTx(tx, user.id, -body.delta, body.note, adminId);
    });
    const updated = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { credits: true } });
    return ok({ credits: updated.credits });
  } catch (e) {
    if (e instanceof z.ZodError) return fail(zodMessage(e));
    return fail(e);
  }
}
