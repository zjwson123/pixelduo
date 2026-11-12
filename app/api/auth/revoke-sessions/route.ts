import { requireUserId, ok, fail, enforceUserRateLimit, refuseCrossSiteRequest } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { dbNow } from "@/lib/ledger";

// Revoke every active session for the current user (including this one).
export async function POST(req: Request) {
  try {
    // Body-less route: without this, a same-site page could log the owner out
    // of every device. See refuseCrossSiteRequest (pass 45).
    refuseCrossSiteRequest(req);
    const userId = await requireUserId();
    // Self-service at worst, but it writes three tables — bound the loop.
    const userLimited = await enforceUserRateLimit(userId, "revoke-sessions", 5, 60_000);
    if (userLimited) return fail(userLimited);
    // The clock token invalidation is judged on: consumedAt is only a marker
    // (the token routes compare `consumedAt: null`), but every other token
    // write in lib/tokens.ts uses the database's now, so this one does too.
    const now = await dbNow(prisma);
    // "Revoke everything" must include API keys — they are a parallel
    // credential that outlives JWT session versions.
    //
    // It must also retire the ONE credential that is neither a session nor a
    // key: an outstanding verification / password-reset link (pass 60). Those
    // links are bearer artifacts with a 1-hour (reset) / 24-hour (verify) TTL,
    // and "sign out everywhere" is what an owner reaches for after suspecting
    // that a mailbox or a browser was compromised — the exact scenario in which
    // a link somebody requested before the revocation must not outlive it. A
    // completed /reset-password already retires every outstanding link for the
    // address (see that route); this route was the other half of the same
    // remediation and left them live.
    await prisma.$transaction([
      prisma.user.update({
        where: { id: userId },
        data: { sessionVersion: { increment: 1 } },
      }),
      prisma.apiKey.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } }),
      prisma.verificationToken.updateMany({
        where: { userId, consumedAt: null },
        data: { consumedAt: now },
      }),
    ]);
    return ok({ revoked: true });
  } catch (e) {
    return fail(e);
  }
}
