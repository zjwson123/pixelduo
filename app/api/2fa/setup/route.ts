import { requireVerifiedUser, ok, fail, enforceRateLimit, enforceUserRateLimit } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { generateTwoFactorSetup } from "@/lib/twofa";

// Step 1 of enabling 2FA: create a secret (stored as pending until confirmed).
export async function POST(req: Request) {
  try {
    const userId = await requireVerifiedUser();
    // Each call overwrites totpPendingSecret — same per-IP + per-account
    // limits as the other 2FA steps.
    const limited = await enforceRateLimit(req, "2fa-setup", 5, 60_000);
    if (limited) return limited;
    const userLimited = await enforceUserRateLimit(userId, "2fa-setup", 5, 60_000);
    if (userLimited) return fail(userLimited);
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { email: true, totpEnabled: true },
    });
    if (user.totpEnabled) return ok({ alreadyEnabled: true });
    const setup = await generateTwoFactorSetup(user.email);
    await prisma.user.update({ where: { id: userId }, data: { totpPendingSecret: setup.secret } });
    return ok(setup);
  } catch (e) {
    return fail(e);
  }
}
