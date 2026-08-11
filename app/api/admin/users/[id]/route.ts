import { requireAdmin } from "@/lib/admin";
import { ok, fail } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { getStorage } from "@/lib/storage";

// Full account removal (GDPR-style) including stored images + orphan rows.
export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  try {
    const adminId = await requireAdmin();
    if (params.id === adminId) return fail(new Error("cannot-delete-self"));
    const images = await prisma.image.findMany({ where: { userId: params.id }, select: { url: true } });
    const storage = getStorage();
    await Promise.allSettled(images.map((i) => storage.delete(i.url)));
    await prisma.$transaction([
      prisma.backupCode.deleteMany({ where: { userId: params.id } }),
      prisma.verificationToken.deleteMany({ where: { userId: params.id } }),
      prisma.creditReminder.deleteMany({ where: { userId: params.id } }),
      prisma.user.delete({ where: { id: params.id } }),
    ]);
    return ok({ deleted: true });
  } catch (e) {
    return fail(e);
  }
}
