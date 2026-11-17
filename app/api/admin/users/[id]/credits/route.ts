import { z } from "zod";
import { ADMIN_TX_OPTIONS, assertAdminActorTx, requireAdminSession } from "@/lib/admin";
import { enforceUserRateLimit, fail, ok, parseJsonBody, readBodyCapped, refuseNul, zodMessage, tooLarge } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { adminGrantTx, adminClawbackTx } from "@/lib/ledger";

const schema = z.object({
  delta: z.number().int().min(-1000000).max(1000000).refine((v) => v !== 0, { message: "delta-zero" }),
  note: z.string().min(1).max(200),
});

// Admin credit adjustment: positive = compensation grant (never expires, spent
// LAST — see GRANT_LOCK_ORDER in lib/ledger.ts; only SIGNUP_BONUS and CHECKIN
// are ahead of paid credits), negative = clawback (FIFO, free/admin grants
// first).
// Rate-limited per IP AND per acting admin: with its sibling below this was one
// of only two routes that parsed a body with no limit of its own, and it moves
// up to 1,000,000 credits per request, so a stolen admin session (or a retry
// loop) had no ceiling below the coarse per-IP middleware cap.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    // %00 → U+0000 → SQLSTATE 22021 → masked 500 + captured incident; the
    // sibling leg of pass 25's body/query NUL guards.
    refuseNul(id);
    const actor = await requireAdminSession();
    const adminId = actor.id;
    // ACCOUNT-keyed (the acting admin), and the only leg: the per-IP one it
    // carried alongside refused admin work to every operator behind a shared
    // egress, which on a one-operator install is the same person.
    const adminLimited = await enforceUserRateLimit(adminId, "admin-credits", 30, 60_000);
    if (adminLimited) return fail(adminLimited);
    const bodyRaw = await readBodyCapped(req, 8 * 1024);
    if ("tooLarge" in bodyRaw) return tooLarge();
    const body = schema.parse(parseJsonBody(bodyRaw.raw));
    const user = await prisma.user.findUnique({ where: { id: id }, select: { id: true } });
    if (!user) return fail(new Error("user-not-found"));
    // Self-targeting is deliberately ALLOWED, and that is a decision rather than
    // an oversight: an admin can mint credits into ANY account, so refusing the
    // caller's own id buys no boundary — a stolen admin session registers a
    // second account (or picks any id from the user list) and grants to that,
    // one extra request. What a "cannot-grant-self" check does buy is a dead end
    // for the single-operator install that compensates itself for testing, which
    // is the flow the admin console and e2e/admin.spec.ts both exercise. The
    // controls that are real: the per-admin rate limit above, the note field,
    // and the ledger row every grant writes with refType "admin" / refId = the
    // acting admin (see pass17-hardening.test.ts, which pins that attribution).
    // A genuine boundary here would be product work — a two-person rule for
    // grants above some size — not a self-id check.
    await prisma.$transaction(async (tx) => {
      if (body.delta > 0) await adminGrantTx(tx, user.id, body.delta, body.note, adminId);
      else await adminClawbackTx(tx, user.id, -body.delta, body.note, adminId);
      // Re-prove the operator against the final state (pass 62). This write
      // records `actorId` on another account's ledger/grant; without the check,
      // a request that passed the gate before a concurrent demotion, erasure or
      // revoke-sessions could still commit — leaving that operator id on a row
      // the erasure's scrub had already run past.
      await assertAdminActorTx(tx, actor);
    }, ADMIN_TX_OPTIONS);
    const updated = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { credits: true } });
    return ok({ credits: updated.credits });
  } catch (e) {
    if (e instanceof z.ZodError) return fail(zodMessage(e));
    return fail(e);
  }
}
