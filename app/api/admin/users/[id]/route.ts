import { Prisma } from "@prisma/client";
import { ADMIN_GUARD_LOCK, assertAdminActorTx, assertAnotherAdminRemains, requireAdminSession } from "@/lib/admin";
import { ok, fail, enforceUserRateLimit, refuseNul } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { GRANT_LOCK_ORDER } from "@/lib/ledger";
import { eraseUserArtifacts, scrubOperatorReferencesTx } from "@/lib/erasure";
import { captureError } from "@/lib/observability";

// Full account removal (GDPR-style) including stored images + orphan rows.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    // %00 → U+0000 → SQLSTATE 22021 → masked 500 + captured incident; the
    // sibling leg of pass 25's body/query NUL guards.
    refuseNul(id);
    const actor = await requireAdminSession();
    const adminId = actor.id;
    // Account-keyed leg: the destructive admin routes had only middleware's
    // coarse 300/min, so a stolen admin session could delete 300 accounts a
    // minute (each one a cascade plus a bounded object sweep).
    const limited = await enforceUserRateLimit(adminId, "admin-user-delete", 30, 60_000);
    if (limited) return fail(limited);
    if (id === adminId) return fail(new Error("cannot-delete-self"));
    // P2025 on the cascade delete below would 500; unknown ids are a plain 404.
    const target = await prisma.user.findUnique({
      where: { id },
      select: { id: true, role: true, email: true },
    });
    if (!target) return fail(new Error("user-not-found"));
    // Cheap pre-check so the destructive part below is not reached for the last
    // admin. The authoritative check is the one inside the transaction — it runs
    // under a lock, which this one cannot, so a race that slips past here is
    // still refused there (the target keeps its account and only its files are
    // gone, which beats removing the install's only admin).
    if (target.role === "admin") {
      const others = await prisma.user.count({ where: { role: "admin", id: { not: id } } });
      if (others < 1) return fail(new Error("cannot-remove-last-admin: promote another admin first"));
    }
    // Generated outputs, reference uploads, checkpointed images and the extend
    // source video all live in storage; lib/erasure deletes them, refuses to
    // claim success on a storage fault, and re-checks under the Job lock that
    // no worker committed a new artifact in between (pass 39 — see the long note
    // in app/api/account/delete).
    await eraseUserArtifacts(
      id,
      {
        lockRows: async (tx) => {
          // Held to commit, so the count and the row deletes are one atomic step.
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ADMIN_GUARD_LOCK})`;
          // And the acting operator is re-proven before anything is swept
          // (pass 62): a request queued on this lock behind the actor's own
          // demotion/erasure/revocation must not delete another account.
          await assertAdminActorTx(tx, actor);
          const current = await tx.user.findUnique({ where: { id }, select: { role: true } });
          if (!current) throw new Error("user-not-found");
          if (current.role === "admin") await assertAnotherAdminRemains(tx, id);
          // Everything the cascade will reach, in the order the writers that take
          // those rows use: Order → Job → CreditGrant → User — see the long note in
          // app/api/account/delete for the cycles this closes (and for why the
          // retry wrapper is the net under the next writer).
          await tx.$queryRaw(Prisma.sql`SELECT id FROM "Order" WHERE "userId" = ${id} ORDER BY id FOR UPDATE`);
          await tx.$queryRaw(Prisma.sql`SELECT id FROM "Job" WHERE "userId" = ${id} ORDER BY id FOR UPDATE`);
          await tx.$queryRaw(
            Prisma.sql`SELECT id FROM "CreditGrant" WHERE "userId" = ${id} ${GRANT_LOCK_ORDER} FOR UPDATE`,
          );
          // LAST, in the order every writer takes these rows. The storage sweep
          // runs inside this transaction (pass 43); the lock keeps a concurrent
          // credential write from racing the cascade.
          await tx.$queryRaw(Prisma.sql`SELECT id FROM "User" WHERE id = ${id} FOR UPDATE`);
        },
        deleteRows: async (tx) => {
          await tx.backupCode.deleteMany({ where: { userId: id } });
          // Null-userId legacy rows for the same address (pass 62) — see the
          // self-service route's note. `target` was read above and is re-checked
          // under the locks, so this is the account being erased.
          await tx.verificationToken.deleteMany({
            where: { OR: [{ userId: id }, { userId: null, email: target.email }] },
          });
          await tx.creditReminder.deleteMany({ where: { userId: id } });
          await tx.apiKey.deleteMany({ where: { userId: id } });
          // PaymentEvent has no FK to Order (lib/payments writes it before an
          // order always exists), so the cascade below leaves the account's
          // payment-event trail behind. Same wipe as the self-service route
          // (pass 60): a subquery, not a bound id list, so an account with more
          // orders than the 32,767-parameter ceiling is still erased.
          await tx.$executeRaw(
            Prisma.sql`DELETE FROM "PaymentEvent" WHERE "orderId" IN (SELECT id FROM "Order" WHERE "userId" = ${id})`,
          );
          // Same no-FK operator references as the self-service route (pass 61):
          // an erased admin must not remain named on other accounts' ledger,
          // grant and feedback rows.
          await scrubOperatorReferencesTx(tx, id);
          await tx.user.delete({ where: { id: id } });
        },
      },
      {
        onStorageFailure: (keys) =>
          captureError(new Error("erasure-storage-delete-failed"), {
            scope: "admin-erasure-storage",
            userId: id,
            failedKeys: keys.length,
          }),
      },
    );
    return ok({ deleted: true });
  } catch (e) {
    return fail(e);
  }
}
