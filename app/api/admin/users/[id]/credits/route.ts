import { z } from "zod";
import { requireAdmin } from "@/lib/admin";
import { ok, fail } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { adminGrantTx, adminClawbackTx } from "@/lib/ledger";

const schema = z.object({
  delta: z.number().int().min(-1000000).max(1000000).refine((v) => v !== 0, { message: "delta-zero" }),
  note: z.string().min(1).max(200),
});

// Admin credit adjustment: positive = compensation grant (never expires,
// consumed first), negative = clawback (FIFO, free/admin grants first).
export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    await requireAdmin();
    const body = schema.parse(await req.json());
    const user = await prisma.user.findUnique({ where: { id: params.id }, select: { id: true } });
    if (!user) return fail(new Error("user-not-found"));
    await prisma.$transaction(async (tx) => {
      if (body.delta > 0) await adminGrantTx(tx, user.id, body.delta, body.note);
      else await adminClawbackTx(tx, user.id, -body.delta, body.note);
    });
    const updated = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { credits: true } });
    return ok({ credits: updated.credits });
  } catch (e) {
    if (e instanceof z.ZodError) return fail(new Error("invalid-input"));
    return fail(e);
  }
}
