import { requireUserId, ok, fail, enforceUserRateLimit } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { paymentMode } from "@/lib/payments";
import { spendableBalance } from "@/lib/credits";

export async function GET() {
  try {
    const userId = await requireUserId();
    const limited = await enforceUserRateLimit(userId, "me", 120, 60_000);
    if (limited) return fail(limited);
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        credits: true,
        plan: true,
        planRenewsAt: true,
        emailVerified: true,
        totpEnabled: true,
        createdAt: true,
      },
    });
    if (!user) return fail(new Error("user-not-found"));
    // The balance the caller may actually spend, which is not always
    // User.credits (see spendableBalance): the column still counts expired
    // grants until the daily sweep, and the workbench used to show "400
    // credits" and "insufficient credits" in the same session. The shared
    // helper is what /api/checkin reads too, so the two cannot disagree. The
    // ledger's own balance stays on the record as `ledgerCredits` rather than
    // being silently replaced; expiredCredits lets the workbench explain the
    // difference ("N credits expired and will be cleared").
    const held = await spendableBalance(userId);
    return ok({
      user: {
        ...user,
        credits: held.spendable,
        ledgerCredits: user.credits,
        expiredCredits: held.expired,
      },
      // Whether checkout actually charges. The client's "no real charge" note is
      // a promise, so the server is the one that decides whether it is true.
      paymentMode: paymentMode(),
    });
  } catch (e) {
    return fail(e);
  }
}
