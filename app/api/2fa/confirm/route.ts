import { z } from "zod";
import { zodMessage, requireVerifiedUser, ok, fail, enforceRateLimit, enforceUserRateLimit, readBodyCapped, ApiError } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import {
  verifyTotp,
  generateBackupCodes,
  hashBackupCode,
  isTwoFactorLocked,
  recordTwoFactorFailure,
  clearTwoFactorFailures,
  TWOFA_LOCKED_ERROR,
} from "@/lib/twofa";
import { sendTwoFactorStateEmail } from "@/lib/mail";
import {
  reservePasswordReauth,
  alertPasswordReauthAbuse,
  refundPasswordReauth,
} from "@/lib/login-guard";
import bcrypt from "bcryptjs";

const schema = z.object({ token: z.string().min(6).max(20), password: z.string().min(1).max(100) });

// Step 2: confirm the pending secret with a live TOTP code; on success enable
// 2FA and mint single-use backup codes (returned to the user exactly once).
// Rate-limited: 6-digit TOTP has only ~1M combinations. Password is re-checked
// (the setup password may be stale by now), and enabling bumps sessionVersion —
// "I just turned on 2FA because I saw suspicious activity" must actually log
// out every pre-existing (possibly stolen) session; the enabling browser signs
// back in with password + TOTP.
export async function POST(req: Request) {
  try {
    const userId = await requireVerifiedUser();
    const limited = await enforceRateLimit(req, "2fa-confirm", 5, 60_000);
    if (limited) return limited;
    const userLimited = await enforceUserRateLimit(userId, "2fa-confirm", 5, 60_000);
    if (userLimited) return fail(userLimited);
    // Cumulative brake (lib/twofa.ts): enrollment verifies a code against the
    // pending secret, so it is a second-factor check like any other.
    if (await isTwoFactorLocked(userId)) return fail(new ApiError(429, TWOFA_LOCKED_ERROR));
    const bodyRaw = await readBodyCapped(req, 8 * 1024);
    if ("tooLarge" in bodyRaw) return new Response("payload too large", { status: 413 });
    const body = schema.parse(JSON.parse(bodyRaw.raw));
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { totpPendingSecret: true, totpEnabled: true, passwordHash: true, email: true },
    });
    if (user.totpEnabled) return ok({ alreadyEnabled: true });
    // The password compare runs before the code check, so it is a full password
    // oracle: reserve it on the LOGIN guard's counters (lib/login-guard.ts).
    const attempt = await reservePasswordReauth(user.email, req);
    if (!attempt.allowed) return fail(new ApiError(429, "rate-limited"));
    if (!(await bcrypt.compare(body.password, user.passwordHash))) {
      await alertPasswordReauthAbuse(user.email);
      return fail(new Error("invalid-password"));
    }
    await refundPasswordReauth(user.email, req);
    if (!verifyTotp(user.totpPendingSecret, body.token)) {
      await recordTwoFactorFailure(userId);
      return fail(new Error("invalid-code"));
    }
    // Deliberately NOT claimed against replay (claimTotpCode): the code was
    // checked against the secret this caller just minted, and the same 30s code
    // is legitimately presented again a moment later when the freshly enabled
    // account signs in — claiming it here would lock the owner out of their own
    // next login (and is exactly what e2e/2fa.spec.ts does). Reaching this
    // comparison already requires the account password.
    await clearTwoFactorFailures(userId);

    const codes = generateBackupCodes();
    // The claim IS the write: whoever flips totpEnabled false→true owns this
    // enrollment and is the only one that mints codes. Without the CAS, two
    // concurrent confirms (a double-click, or a retried request — both pass the
    // pre-read above and verify the same pending secret) each replaced the whole
    // BackupCode set with its own ten codes: two different sets were returned
    // with 200, only the last one was stored, and a user who copied the first
    // response held recovery codes that never worked — discovered, typically, at
    // the moment they needed them.
    const claimed = await prisma.$transaction(async (tx) => {
      const claim = await tx.user.updateMany({
        where: { id: userId, totpEnabled: false },
        data: {
          totpSecret: user.totpPendingSecret,
          totpPendingSecret: null,
          totpEnabled: true,
          sessionVersion: { increment: 1 },
        },
      });
      if (claim.count !== 1) return false;
      // Revoke API keys alongside the session bump. authenticateApiKey never
      // consults sessionVersion, so an attacker who trialled the password
      // before 2FA was on could mint a pd_live_ key that survived the very
      // remediation the alert tells the owner to perform ("enable 2FA") — the
      // key has no expiry and keeps spending the victim's credits. This is the
      // same pairing reset-password and revoke-sessions already do; enablement
      // is the one sessionVersion bump that was missing it.
      await tx.apiKey.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await tx.backupCode.deleteMany({ where: { userId } });
      await tx.backupCode.createMany({
        data: codes.map((c) => ({ userId, codeHash: hashBackupCode(c) })),
      });
      return true;
    });
    // The loser of the race reports the same shape as the pre-read branch: the
    // enrollment is already on, and the codes belong to the request that won.
    if (!claimed) return ok({ alreadyEnabled: true });
    // The owner must learn about an enrollment they did not perform: with only
    // a leaked password an attacker can bind 2FA here and lock the real owner
    // out (reset-password does not clear totpEnabled — see lib/mail.ts).
    await sendTwoFactorStateEmail(user.email, true);
    return ok({ enabled: true, backupCodes: codes });
  } catch (e) {
    if (e instanceof z.ZodError) return fail(zodMessage(e));
    return fail(e);
  }
}
