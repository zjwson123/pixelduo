import bcrypt from "bcryptjs";
import { z } from "zod";
import { ApiError, enforceUserRateLimit, fail, ok, parseJsonBody, readBodyCapped, requireVerifiedUser, zodMessage, tooLarge } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { passwordReauthRefusal } from "@/lib/auth";
import {
  verifyTotp,
  twoFactorLockStatus,
  recordTwoFactorFailure,
  clearTwoFactorFailures,
  claimTotpCode,
  TWOFA_LOCKED_ERROR,
} from "@/lib/twofa";
import { sendTwoFactorStateEmail } from "@/lib/mail";
import {
  reservePasswordReauth,
  alertPasswordReauthAbuse,
  refundPasswordReauth,
} from "@/lib/login-guard";

const schema = z.object({
  password: z.string().min(1).max(100),
  token: z.string().min(6).max(20),
});

// Disabling requires the account password + a live TOTP code (backup codes
// intentionally not accepted so a stolen code can't disable 2FA).
// Rate-limited per ACCOUNT: 6-digit TOTP has only ~1M combinations, and the
// per-IP leg this used to add first only let a neighbour's traffic refuse the
// downgrade to its co-tenants (and vice versa).
export async function POST(req: Request) {
  try {
    const userId = await requireVerifiedUser();
    const limited = await enforceUserRateLimit(userId, "2fa-disable", 5, 60_000);
    if (limited) return fail(limited);
    // Cumulative brake (lib/twofa.ts) before any comparison: turning the second
    // factor off is the downgrade an attacker who knows the password wants, so
    // it is bound by the same counter as the login step.
    const lock = await twoFactorLockStatus(userId);
    if (lock.locked) return fail(new ApiError(429, TWOFA_LOCKED_ERROR, lock.retryAfterSec));
    const bodyRaw = await readBodyCapped(req, 8 * 1024);
    if ("tooLarge" in bodyRaw) return tooLarge();
    const body = schema.parse(parseJsonBody(bodyRaw.raw));
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { passwordHash: true, totpSecret: true, totpEnabled: true, email: true },
    });
    if (!user.totpEnabled) return ok({ alreadyDisabled: true });
    const refusal = passwordReauthRefusal(user.passwordHash);
    if (refusal) return fail(refusal);
    // A wrong password is deliberately not a SECOND-FACTOR brake failure: that
    // counter bounds the 6-digit code, and counting password guesses here would
    // let a stolen session spend the owner's code budget. The password has its
    // own guard — the login guard, which the per-minute buckets above are not:
    // reserve the attempt on it before the compare (lib/login-guard.ts).
    const attempt = await reservePasswordReauth(user.email, req);
    if (!attempt.allowed) return fail(new ApiError(429, "rate-limited", attempt.retryAfterSec));
    if (!(await bcrypt.compare(body.password, user.passwordHash))) {
      await alertPasswordReauthAbuse(user.email);
      return fail(new Error("invalid-password"));
    }
    await refundPasswordReauth(user.email, req);
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
          // while 2FA was on stayed valid, and a pd_live_ key kept working
          // against an account the user believed was still protected. (At the
          // time this was written, keys survived sessionVersion bumps entirely;
          // pass 25 later gave ApiKey a sessionVersion stamp that
          // authenticateApiKey compares, so the bump now also kills keys
          // atomically — this explicit revoke stays as the immediate,
          // row-visible half.) Mirrors 2fa/confirm, reset-password and
          // revoke-sessions.
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
