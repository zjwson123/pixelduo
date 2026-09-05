import { z } from "zod";
import { requireUserId, ok, fail } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { getStorage } from "@/lib/storage";
import { verifyTotp, useBackupCode } from "@/lib/twofa";
import bcrypt from "bcryptjs";

const schema = z
  .object({
    confirm: z.literal(true),
    // Irreversible erasure requires re-authentication: a hijacked cookie alone
    // must not destroy the account (2FA-enabled accounts need the 2nd factor).
    password: z.string().min(1).max(100),
    token: z.string().min(6).max(20).optional(),
    backupCode: z.string().min(8).max(40).optional(),
  })
  .refine((v) => v.token || v.backupCode, { message: "invalid-input" });

// GDPR / PIPL erasure: deletes the account and all related data + stored image files.
export async function POST(req: Request) {
  try {
    const userId = await requireUserId();
    const body = schema.parse(await req.json());
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { passwordHash: true, totpSecret: true, totpEnabled: true },
    });
    if (!(await bcrypt.compare(body.password, user.passwordHash))) return fail(new Error("invalid-password"));
    if (user.totpEnabled && user.totpSecret) {
      const ok2 = body.token
        ? verifyTotp(user.totpSecret, body.token)
        : await useBackupCode(userId, body.backupCode!);
      if (!ok2) return fail(new Error("invalid-code"));
    }
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
