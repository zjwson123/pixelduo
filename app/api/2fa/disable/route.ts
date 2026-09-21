import bcrypt from "bcryptjs";
import { z } from "zod";
import { zodMessage, requireVerifiedUser, ok, fail, enforceRateLimit, enforceUserRateLimit, readBodyCapped, ApiError } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import {
  verifyTotp,
  isTwoFactorLocked,
  recordTwoFactorFailure,
  clearTwoFactorFailures,
  claimTotpCode,
  TWOFA_LOCKED_ERROR,
} from "@/lib/twofa";
import { sendTwoFactorStateEmail } from "@/lib/mail";

const schema = z.object({
  password: z.string().min(1).max(100),
  token: z.string().min(6).max(20),
});

// Disabling requires the account password + a live TOTP code (backup codes
// intentionally not accepted so a stolen code can't disable 2FA).
// Rate-limited per IP and per account: 6-digit TOTP has only ~1M combinations.
export async function POST(req: Request) {
  try {
    const userId = await requireVerifiedUser();
    const limited = await enforceRateLimit(req, "2fa-disable", 5, 60_000);
    if (limited) return limited;
    const userLimited = await enforceUserRateLimit(userId, "2fa-disable", 5, 60_000);
    if (userLimited) return fail(userLimited);
    // Cumulative brake (lib/twofa.ts) before any comparison: turning the second
    // factor off is the downgrade an attacker who knows the password wants, so
    // it is bound by the same counter as the login step.
    if (await isTwoFactorLocked(userId)) return fail(new ApiError(429, TWOFA_LOCKED_ERROR));
    const bodyRaw = await readBodyCapped(req, 8 * 1024);
    if ("tooLarge" in bodyRaw) return new Response("payload too large", { status: 413 });
    const body = schema.parse(JSON.parse(bodyRaw.raw));
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { passwordHash: true, totpSecret: true, totpEnabled: true, email: true },
    });
    if (!user.totpEnabled) return ok({ alreadyDisabled: true });
    // A wrong password is deliberately not a brake failure: it has its own
    // guard, and counting it here would let a stolen session lock the owner out
    // of the second factor (and so out of this route's own recovery) for a day.
    if (!(await bcrypt.compare(body.password, user.passwordHash))) return fail(new Error("invalid-password"));
    // Replay rejection: a code observed inside its ±1 step window must not also
    // be able to turn the second factor off.
    if (!verifyTotp(user.totpSecret, body.token) || !(await claimTotpCode(userId, body.token))) {
      await recordTwoFactorFailure(userId);
      return fail(new Error("invalid-code"));
    }
    await clearTwoFactorFailures(userId);
    await prisma.$transaction([
      prisma.user.update({
        where: { id: userId },
        data: {
          totpSecret: null,
          totpPendingSecret: null,
          totpEnabled: false,
          // Turning the second factor OFF is a security downgrade, and it was
          // the only such transition that revoked nothing: sessions minted
          // while 2FA was on stayed valid, and API keys survive sessionVersion
          // bumps entirely (authenticateApiKey never reads it), so a pd_live_
          // key kept working against an account the user believed was still
          // protected. Mirrors 2fa/confirm, reset-password and revoke-sessions.
          sessionVersion: { increment: 1 },
        },
      }),
      prisma.apiKey.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
      prisma.backupCode.deleteMany({ where: { userId } }),
    ]);
    // Silent state changes are indistinguishable from a hostile one — see
    // sendTwoFactorStateEmail.
    await sendTwoFactorStateEmail(user.email, false);
    return ok({ disabled: true });
  } catch (e) {
    if (e instanceof z.ZodError) return fail(zodMessage(e));
    return fail(e);
  }
}
