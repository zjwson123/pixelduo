import { requireAdmin } from "@/lib/admin";
import { ok, fail } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { getStorage } from "@/lib/storage";

// Full account removal (GDPR-style) including stored images + orphan rows.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const adminId = await requireAdmin();
    if (id === adminId) return fail(new Error("cannot-delete-self"));
    // P2025 on the cascade delete below would 500; unknown ids are a plain 404.
    const target = await prisma.user.findUnique({ where: { id }, select: { id: true } });
    if (!target) return fail(new Error("user-not-found"));
    // Generated outputs AND user-uploaded reference images (Job.refImageKey)
    // — mirrors the self-service erasure route.
    const images = await prisma.image.findMany({ where: { userId: id }, select: { url: true } });
    const jobs = await prisma.job.findMany({ where: { userId: id }, select: { refImageKey: true } });
    const refKeys = jobs.map((j) => j.refImageKey).filter((k): k is string => Boolean(k));
    const storage = getStorage();
    await Promise.allSettled([
      ...images.map((i) => storage.delete(i.url)),
      ...refKeys.map((k) => storage.delete(k)),
    ]);
    await prisma.$transaction([
      prisma.backupCode.deleteMany({ where: { userId: id } }),
      prisma.verificationToken.deleteMany({ where: { userId: id } }),
      prisma.creditReminder.deleteMany({ where: { userId: id } }),
      prisma.apiKey.deleteMany({ where: { userId: id } }),
      prisma.user.delete({ where: { id: id } }),
    ]);
    return ok({ deleted: true });
  } catch (e) {
    return fail(e);
  }
}
