import { Prisma } from "@prisma/client";
import { ADMIN_GUARD_LOCK, assertAnotherAdminRemains, requireAdmin } from "@/lib/admin";
import { ok, fail, enforceUserRateLimit } from "@/lib/api";
import { prisma, withDeadlockRetry } from "@/lib/prisma";
import { GRANT_LOCK_ORDER } from "@/lib/ledger";
import { deleteObjectsBounded } from "@/lib/storage";
import { checkpointKeys } from "@/lib/queue";

// Full account removal (GDPR-style) including stored images + orphan rows.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const adminId = await requireAdmin();
    // Account-keyed leg: the destructive admin routes had only middleware's
    // coarse 300/min, so a stolen admin session could delete 300 accounts a
    // minute (each one a cascade plus a bounded object sweep).
    const limited = await enforceUserRateLimit(adminId, "admin-user-delete", 30, 60_000);
    if (limited) return fail(limited);
    if (id === adminId) return fail(new Error("cannot-delete-self"));
    // P2025 on the cascade delete below would 500; unknown ids are a plain 404.
    const target = await prisma.user.findUnique({ where: { id }, select: { id: true, role: true } });
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
    // Generated outputs, user-uploaded reference images (Job.refImageKey) and
    // the images a job had already checkpointed before it died — mirrors the
    // self-service erasure route. Deleted before the rows and with bounded
    // concurrency: rows go first in gallery delete, but here the User cascade
    // removes the Image rows, so afterwards nothing could name these keys.
    const images = await prisma.image.findMany({ where: { userId: id }, select: { url: true } });
    const jobs = await prisma.job.findMany({
      where: { userId: id },
      select: { refImageKey: true, images: true, sourceVideoKey: true },
    });
    const refKeys = jobs.map((j) => j.refImageKey).filter((k): k is string => Boolean(k));
    const staged = jobs.flatMap((j) => checkpointKeys(j.images));
    // Job.sourceVideoKey too — see the note in app/api/account/delete: an extend
    // job is the only row that names the clip it continues, and the cascade
    // below removes the rows before anything could look again.
    const sourceKeys = jobs.map((j) => j.sourceVideoKey).filter((k): k is string => Boolean(k));
    await deleteObjectsBounded([
      ...images.map((i) => i.url),
      ...refKeys,
      ...staged,
      ...sourceKeys,
    ]);
    await withDeadlockRetry(() =>
      prisma.$transaction(async (tx) => {
        // Held to commit, so the count and the row deletes are one atomic step.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ADMIN_GUARD_LOCK})`;
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
        await tx.backupCode.deleteMany({ where: { userId: id } });
        await tx.verificationToken.deleteMany({ where: { userId: id } });
        await tx.creditReminder.deleteMany({ where: { userId: id } });
        await tx.apiKey.deleteMany({ where: { userId: id } });
        await tx.user.delete({ where: { id: id } });
      }),
    );
    return ok({ deleted: true });
  } catch (e) {
    return fail(e);
  }
}
