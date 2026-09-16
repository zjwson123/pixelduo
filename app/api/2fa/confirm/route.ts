import { z } from "zod";
import { requireVerifiedUser, ok, fail, enforceRateLimit, enforceUserRateLimit, readBodyCapped } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { verifyTotp, generateBackupCodes, hashBackupCode } from "@/lib/twofa";
import { sendTwoFactorStateEmail } from "@/lib/mail";
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
    const bodyRaw = await readBodyCapped(req, 8 * 1024);
    if ("tooLarge" in bodyRaw) return new Response("payload too large", { status: 413 });
    const body = schema.parse(JSON.parse(bodyRaw.raw));
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { totpPendingSecret: true, totpEnabled: true, passwordHash: true, email: true },
    });
    if (user.totpEnabled) return ok({ alreadyEnabled: true });
    if (!(await bcrypt.compare(body.password, user.passwordHash))) return fail(new Error("invalid-password"));
    if (!verifyTotp(user.totpPendingSecret, body.token)) return fail(new Error("invalid-code"));

    const codes = generateBackupCodes();
    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: {
          totpSecret: user.totpPendingSecret,
          totpPendingSecret: null,
          totpEnabled: true,
          sessionVersion: { increment: 1 },
        },
      });
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
    });
    // The owner must learn about an enrollment they did not perform: with only
    // a leaked password an attacker can bind 2FA here and lock the real owner
    // out for good (reset-password does not clear totpEnabled).
    await sendTwoFactorStateEmail(user.email, true);
    return ok({ enabled: true, backupCodes: codes });
  } catch (e) {
    if (e instanceof z.ZodError) return fail(new Error("invalid-input"));
    return fail(e);
  }
}
