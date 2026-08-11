import { requireVerifiedUser, ok, fail } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { generateTwoFactorSetup } from "@/lib/twofa";

// Step 1 of enabling 2FA: create a secret (stored as pending until confirmed).
export async function POST() {
  try {
    const userId = await requireVerifiedUser();
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
