import { z } from "zod";
import { enforceUserRateLimit, fail, ok, parseJsonBody, readBodyCapped, refuseNul, zodMessage, tooLarge } from "@/lib/api";
import { assertAdminActorTx, requireAdminSession } from "@/lib/admin";
import { prisma } from "@/lib/prisma";

const schema = z.object({ status: z.enum(["new", "done"]) });

// Mark a message handled (or put it back). `handledBy` records which operator
// closed it, so a shared mailbox does not turn into "someone already answered
// this?" guesswork.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    // %00 → U+0000 → SQLSTATE 22021 → masked 500 + captured incident; the
    // sibling leg of pass 25's body/query NUL guards.
    refuseNul(id);
    const actor = await requireAdminSession();
    const adminId = actor.id;
    const limited = await enforceUserRateLimit(adminId, "admin-feedback-write", 60, 60_000);
    if (limited) return fail(limited);
    const bodyRaw = await readBodyCapped(req, 4 * 1024);
    if ("tooLarge" in bodyRaw) return tooLarge();
    const body = schema.parse(parseJsonBody(bodyRaw.raw));
    // updateMany with the id in the predicate: a P2025 on an unknown id would
    // otherwise surface as a 500 instead of a 404.
    //
    // The operator's authority is re-proven in the same transaction (pass 62):
    // `handledBy` is an operator id on a row the erasure scrub reaches only
    // while the actor is still being erased — a queued PATCH landing after that
    // scrub left the id behind.
    const res = await prisma.$transaction(async (tx) => {
      const updated = await tx.feedback.updateMany({
        where: { id },
        data: {
          status: body.status,
          handledAt: body.status === "done" ? new Date() : null,
          handledBy: body.status === "done" ? adminId : null,
        },
      });
      if (updated.count > 0) await assertAdminActorTx(tx, actor);
      return updated;
    });
    if (res.count === 0) return fail(new Error("item-not-found"));
    return ok({ updated: true });
  } catch (e) {
    if (e instanceof z.ZodError) return fail(zodMessage(e));
    return fail(e);
  }
}
