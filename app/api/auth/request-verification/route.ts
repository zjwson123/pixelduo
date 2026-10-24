import { requireUserId, ok, fail, enforceUserRateLimit, refuseCrossSiteRequest } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { createToken } from "@/lib/tokens";
import { sendVerificationEmail, reserveAuthMailSend } from "@/lib/mail";

// Resend the verification email for the current (unverified) user.
export async function POST(req: Request) {
  try {
    // Body-less route: see refuseCrossSiteRequest (pass 45).
    refuseCrossSiteRequest(req);
    const userId = await requireUserId();
    // Per-ACCOUNT cap, and the only leg. The per-IP one it used to carry first
    // refused the whole verify→activate funnel to every neighbour of whoever
    // spent it — and the address being mailed is the caller's OWN (the row is
    // read from the session below), so there is no third party for an IP bucket
    // to protect: the per-account cap is the limit that matters, plus the
    // global hourly ceiling in lib/mail.ts.
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
