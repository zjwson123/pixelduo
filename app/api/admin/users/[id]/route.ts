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
    const images = await prisma.image.findMany({ where: { userId: id }, select: { url: true } });
    const storage = getStorage();
    await Promise.allSettled(images.map((i) => storage.delete(i.url)));
    await prisma.$transaction([
      prisma.backupCode.deleteMany({ where: { userId: id } }),
      prisma.verificationToken.deleteMany({ where: { userId: id } }),
      prisma.creditReminder.deleteMany({ where: { userId: id } }),
      prisma.user.delete({ where: { id: id } }),
    ]);
    return ok({ deleted: true });
  } catch (e) {
    return fail(e);
  }
}
