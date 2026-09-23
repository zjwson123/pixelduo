import { requireUserId, ok, fail, enforceRateLimit, enforceUserRateLimit } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { createToken } from "@/lib/tokens";
import { sendVerificationEmail, reserveAuthMailSend } from "@/lib/mail";

// Resend the verification email for the current (unverified) user.
export async function POST(req: Request) {
  try {
    const userId = await requireUserId();
    const limited = await enforceRateLimit(req, "verify-resend", 5, 15 * 60_000);
    if (limited) return limited;
    // Per-account cap on top of the per-IP one, for the same reason
    // forgot-password has one: an attacker rotating source addresses must not
    // be able to mail-bomb a single address without limit. This route needs
    // only a live session (no password, no second factor), and the account for
    // an address anyone can create without proving ownership, so the per-IP
    // brake alone is bypassable.
    const userLimited = await enforceUserRateLimit(userId, "verify-resend-account", 5, 15 * 60_000);
    if (userLimited) return fail(userLimited);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.emailVerified) return ok({ alreadyVerified: true });
    // Global hourly ceiling (lib/mail.ts). Reported rather than silently
    // swallowed: the caller is authenticated and knows whether this address
    // exists, so there is nothing to hide, and a toast that promises a mail
    // nobody sent is how a user ends up waiting for a link that is not coming.
    // The check precedes the rotation, so the link already in their inbox stays
    // valid either way.
    if (!(await reserveAuthMailSend("verify"))) {
      return fail(new Error("cannot-send-mail: the mail service is at its hourly limit — try again in a few minutes"));
    }
    const token = await createToken(user.email, "verify-email", user.id);
    await sendVerificationEmail(user.email, token);
    return ok({ sent: true });
  } catch (e) {
    return fail(e);
  }
}
