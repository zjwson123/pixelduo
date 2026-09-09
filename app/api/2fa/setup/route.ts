import { z } from "zod";
import { requireVerifiedUser, ok, fail, enforceRateLimit, enforceUserRateLimit } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { generateTwoFactorSetup } from "@/lib/twofa";
import bcrypt from "bcryptjs";

const schema = z.object({ password: z.string().min(1).max(100) });

// Step 1 of enabling 2FA: create a secret (stored as pending until confirmed).
// Password re-auth: the returned secret lets a session thief enable 2FA with
// their own authenticator and lock the real owner out of the account.
export async function POST(req: Request) {
  try {
    const userId = await requireVerifiedUser();
    // Each call overwrites totpPendingSecret — same per-IP + per-account
    // limits as the other 2FA steps.
    const limited = await enforceRateLimit(req, "2fa-setup", 5, 60_000);
    if (limited) return limited;
    const userLimited = await enforceUserRateLimit(userId, "2fa-setup", 5, 60_000);
    if (userLimited) return fail(userLimited);
    const body = schema.parse(await req.json());
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { email: true, totpEnabled: true, passwordHash: true },
    });
    if (user.totpEnabled) return ok({ alreadyEnabled: true });
    if (!(await bcrypt.compare(body.password, user.passwordHash))) return fail(new Error("invalid-password"));
    const setup = await generateTwoFactorSetup(user.email);
    await prisma.user.update({ where: { id: userId }, data: { totpPendingSecret: setup.secret } });
    return ok(setup);
  } catch (e) {
    if (e instanceof z.ZodError) return fail(new Error("invalid-input"));
    return fail(e);
  }
}
