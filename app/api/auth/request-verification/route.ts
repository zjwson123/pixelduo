import { requireUserId, ok, fail, enforceRateLimit } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { createToken } from "@/lib/tokens";
import { sendVerificationEmail } from "@/lib/mail";

// Resend the verification email for the current (unverified) user.
export async function POST(req: Request) {
  try {
    const userId = await requireUserId();
    const limited = await enforceRateLimit(req, "verify", 5, 15 * 60_000);
    if (limited) return limited;
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.emailVerified) return ok({ alreadyVerified: true });
    const token = await createToken(user.email, "verify-email", user.id);
    await sendVerificationEmail(user.email, token);
    return ok({ sent: true });
  } catch (e) {
    return fail(e);
  }
}
