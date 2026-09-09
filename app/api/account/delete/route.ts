import { z } from "zod";
import { requireUserId, ok, fail, enforceRateLimit, enforceUserRateLimit } from "@/lib/api";
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
    // Re-auth brute force (password + TOTP/backup-code guesses) gets the same
    // per-IP + per-account limits as the dedicated 2FA endpoints.
    const limited = await enforceRateLimit(req, "account-delete", 5, 60_000);
    if (limited) return limited;
    const userLimited = await enforceUserRateLimit(userId, "account-delete", 5, 60_000);
    if (userLimited) return fail(userLimited);
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
    // Generated outputs AND user-uploaded reference images (Job.refImageKey —
    // for i2v/edit workflows these can be personal photos, the most sensitive
    // files we hold) must both be erased for a true GDPR/PIPL delete.
    const images = await prisma.image.findMany({ where: { userId }, select: { url: true } });
    const jobs = await prisma.job.findMany({ where: { userId }, select: { refImageKey: true } });
    const refKeys = jobs.map((j) => j.refImageKey).filter((k): k is string => Boolean(k));
    const storage = getStorage();
    await Promise.allSettled([
      ...images.map((i) => storage.delete(i.url)),
      ...refKeys.map((k) => storage.delete(k)),
    ]);
    await prisma.$transaction([
      prisma.backupCode.deleteMany({ where: { userId } }),
      prisma.verificationToken.deleteMany({ where: { userId } }),
      prisma.creditReminder.deleteMany({ where: { userId } }),
      // ApiKey has no FK relation (by design, hash-only table), so it needs an
      // explicit wipe or key metadata survives the erasure request.
      prisma.apiKey.deleteMany({ where: { userId } }),
      prisma.user.delete({ where: { id: userId } }),
    ]);
    return ok({ deleted: true });
  } catch (e) {
    if (e instanceof z.ZodError) return fail(new Error("invalid-input"));
    return fail(e);
  }
}
