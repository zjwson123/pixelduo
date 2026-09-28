import { requireUserId, ok, fail, enforceUserRateLimit } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { paymentMode } from "@/lib/payments";

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
    // User.credits: spendability ends at expiresAt (lib/ledger.ts filters
    // `expiresAt > now()`) while the sweep that zeroes expired grants runs
    // DAILY. Inside that window the column still counts credits the spend path
    // refuses, so the workbench showed "400 credits" and "insufficient credits"
    // in the same session. One aggregate, evaluated by the database's clock so
    // it agrees exactly with the spend path; the ledger's own balance stays on
    // the record as `ledgerCredits` rather than being silently replaced.
    const [held] = await prisma.$queryRawUnsafe<Array<{ spendable: bigint; expired: bigint }>>(
      `SELECT
         COALESCE(SUM(CASE WHEN "expiresAt" IS NULL OR "expiresAt" > now() THEN remaining ELSE 0 END), 0)::bigint AS spendable,
         COALESCE(SUM(CASE WHEN "expiresAt" IS NOT NULL AND "expiresAt" <= now() THEN remaining ELSE 0 END), 0)::bigint AS expired
       FROM "CreditGrant" WHERE "userId" = $1 AND remaining > 0`,
      userId,
    );
    return ok({
      user: {
        ...user,
        credits: Number(held?.spendable ?? user.credits),
        ledgerCredits: user.credits,
        // Reported rather than hidden: the workbench can explain the difference
        // ("N credits expired and will be cleared") instead of leaving a number
        // that quietly drops at the next sweep.
        expiredCredits: Number(held?.expired ?? 0),
      },
      // Whether checkout actually charges. The client's "no real charge" note is
      // a promise, so the server is the one that decides whether it is true.
      paymentMode: paymentMode(),
    });
  } catch (e) {
    return fail(e);
  }
}
