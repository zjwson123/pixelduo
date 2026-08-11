import bcrypt from "bcryptjs";
import { z } from "zod";
import { requireVerifiedUser, ok, fail } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { verifyTotp } from "@/lib/twofa";

const schema = z.object({
  password: z.string().min(1).max(100),
  token: z.string().min(6).max(20),
});

// Disabling requires the account password + a live TOTP code (backup codes
// intentionally not accepted so a stolen code can't disable 2FA).
export async function POST(req: Request) {
  try {
    const userId = await requireVerifiedUser();
    const body = schema.parse(await req.json());
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { passwordHash: true, totpSecret: true, totpEnabled: true },
    });
    if (!user.totpEnabled) return ok({ alreadyDisabled: true });
    if (!(await bcrypt.compare(body.password, user.passwordHash))) return fail(new Error("invalid-password"));
    if (!verifyTotp(user.totpSecret, body.token)) return fail(new Error("invalid-code"));
    await prisma.$transaction([
      prisma.user.update({
        where: { id: userId },
        data: { totpSecret: null, totpPendingSecret: null, totpEnabled: false },
      }),
      prisma.backupCode.deleteMany({ where: { userId } }),
    ]);
    return ok({ disabled: true });
  } catch (e) {
    if (e instanceof z.ZodError) return fail(new Error("invalid-input"));
    return fail(e);
  }
}
