import { z } from "zod";
import { ADMIN_GUARD_LOCK, ADMIN_TX_OPTIONS, assertAdminActorTx, assertAnotherAdminRemains, requireAdminSession } from "@/lib/admin";
import { enforceUserRateLimit, fail, ok, parseJsonBody, readBodyCapped, refuseNul, zodMessage, tooLarge } from "@/lib/api";
import { prisma } from "@/lib/prisma";

const schema = z.object({ role: z.enum(["user", "admin"]) });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    // %00 → U+0000 → SQLSTATE 22021 → masked 500 + captured incident; the
    // sibling leg of pass 25's body/query NUL guards.
    refuseNul(id);
    const actor = await requireAdminSession();
    const adminId = actor.id;
    // Privilege changes carry their own ACCOUNT-keyed ceiling (the acting
    // admin); the per-IP leg it also carried let one operator's traffic refuse
    // role changes to their neighbours.
    const adminLimited = await enforceUserRateLimit(adminId, "admin-role", 30, 60_000);
    if (adminLimited) return fail(adminLimited);
    const bodyRaw = await readBodyCapped(req, 8 * 1024);
    if ("tooLarge" in bodyRaw) return tooLarge();
    const body = schema.parse(parseJsonBody(bodyRaw.raw));
    if (id === adminId && body.role !== "admin") {
      return fail(new Error("cannot-demote-self"));
    }
    // The self-check above only covers the caller. Two admins demoting each
    // other at the same time each pass it — the count and the write have to be
    // one atomic step, taken under a lock held to commit, or both writes land
    // and the install is left with no admin and no in-app way to mint one.
    const updated = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ADMIN_GUARD_LOCK})`;      const target = await tx.user.findUnique({
        where: { id },
        select: { id: true, role: true, emailVerified: true },
      });
      // P2025 on the update below would 500; unknown ids are a plain 404.
      if (!target) throw new Error("user-not-found");
      // Same pre-registration takeover the promote script refuses (pass 43):
      // registration mints an account for any address before verification, and
      // requireAdmin checks only `role`. Granting operator rights to an
      // unverified account hands the console to whoever registered that
      // address first.
      if (body.role === "admin" && target.role !== "admin" && !target.emailVerified) {
        throw new Error("cannot-promote-unverified: verify the account's email first");
      }
      if (target.role === "admin" && body.role !== "admin") {
        await assertAnotherAdminRemains(tx, id);
      }
      const updated = await tx.user.update({
        where: { id: id },
        data: { role: body.role },
        select: { id: true, role: true },
      });
      // The actor's authority is re-proven against the FINAL state (pass 62):
      // a demotion/erasure/revocation that committed while this transaction
      // waited on the guard lock must not let the queued request land.
      await assertAdminActorTx(tx, actor);
      return updated;
    }, ADMIN_TX_OPTIONS);
    return ok({ user: updated });
  } catch (e) {
    if (e instanceof z.ZodError) return fail(zodMessage(e));
    return fail(e);
  }
}
