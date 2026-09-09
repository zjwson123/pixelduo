import { z } from "zod";
import { requireVerifiedUser, ok, fail, enforceRateLimit, enforceUserRateLimit } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { verifyTotp, generateBackupCodes, hashBackupCode } from "@/lib/twofa";
import bcrypt from "bcryptjs";

const schema = z.object({ token: z.string().min(6).max(20), password: z.string().min(1).max(100) });

// Step 2: confirm the pending secret with a live TOTP code; on success enable
// 2FA and mint single-use backup codes (returned to the user exactly once).
// Rate-limited: 6-digit TOTP has only ~1M combinations. Password is re-checked
// (the setup password may be stale by now), and enabling bumps sessionVersion —
// "I just turned on 2FA because I saw suspicious activity" must actually log
// out every pre-existing (possibly stolen) session; the enabling browser signs
// back in with password + TOTP.
export async function POST(req: Request) {
  try {
    const userId = await requireVerifiedUser();
    const limited = await enforceRateLimit(req, "2fa-confirm", 5, 60_000);
    if (limited) return limited;
    const userLimited = await enforceUserRateLimit(userId, "2fa-confirm", 5, 60_000);
    if (userLimited) return fail(userLimited);
    const body = schema.parse(await req.json());
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { totpPendingSecret: true, totpEnabled: true, passwordHash: true },
    });
    if (user.totpEnabled) return ok({ alreadyEnabled: true });
    if (!(await bcrypt.compare(body.password, user.passwordHash))) return fail(new Error("invalid-password"));
    if (!verifyTotp(user.totpPendingSecret, body.token)) return fail(new Error("invalid-code"));

    const codes = generateBackupCodes();
    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: {
          totpSecret: user.totpPendingSecret,
          totpPendingSecret: null,
          totpEnabled: true,
          sessionVersion: { increment: 1 },
        },
      });
      await tx.backupCode.deleteMany({ where: { userId } });
      await tx.backupCode.createMany({
        data: codes.map((c) => ({ userId, codeHash: hashBackupCode(c) })),
      });
    });
    return ok({ enabled: true, backupCodes: codes });
  } catch (e) {
    if (e instanceof z.ZodError) return fail(new Error("invalid-input"));
    return fail(e);
  }
}
