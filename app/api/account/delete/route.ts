import { z } from "zod";
import { requireUserId, ok, fail } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { getStorage } from "@/lib/storage";

const schema = z.object({ confirm: z.literal(true) });

// GDPR / PIPL erasure: deletes the account and all related data + stored image files.
export async function POST(req: Request) {
  try {
    const userId = await requireUserId();
    schema.parse(await req.json());
    const images = await prisma.image.findMany({ where: { userId }, select: { url: true } });
    const storage = getStorage();
    await Promise.allSettled(images.map((i) => storage.delete(i.url)));
    await prisma.$transaction([
      prisma.backupCode.deleteMany({ where: { userId } }),
      prisma.verificationToken.deleteMany({ where: { userId } }),
      prisma.creditReminder.deleteMany({ where: { userId } }),
      prisma.user.delete({ where: { id: userId } }),
    ]);
    return ok({ deleted: true });
  } catch (e) {
    if (e instanceof z.ZodError) return fail(new Error("invalid-input"));
    return fail(e);
  }
}
