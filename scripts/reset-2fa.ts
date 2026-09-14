import { prisma } from "../lib/prisma";
import { getMailer } from "../lib/mail";

// Operator-only 2FA reset. There is deliberately no API route for this: the
// only in-app ways to clear the second factor require a live TOTP code or a
// backup code, so a user who loses both (or is locked out by a hostile
// enrollment) had no recovery path at all short of manual DB surgery.
//
// Usage: npx tsx scripts/reset-2fa.ts <email> [--notify]
//
// Clearing 2FA is a security-state change, so it also bumps sessionVersion
// (killing every existing session) and revokes API keys, and it emails the
// account owner unless --notify is omitted — a silent reset would be
// indistinguishable from an attack.
async function main() {
  const [email, ...flags] = process.argv.slice(2);
  if (!email) throw new Error("usage: npx tsx scripts/reset-2fa.ts <email> [--notify]");
  const notify = flags.includes("--notify");
  const e = email.toLowerCase().trim();

  const user = await prisma.user.findUnique({ where: { email: e } });
  if (!user) throw new Error(`user not found: ${e}`);
  if (!user.totpEnabled && !user.totpSecret && !user.totpPendingSecret) {
    console.log(`[reset-2fa] ${e} has no 2FA configured — nothing to do`);
    return;
  }

  await prisma.$transaction([
    prisma.user.update({
      where: { id: user.id },
      data: {
        totpEnabled: false,
        totpSecret: null,
        totpPendingSecret: null,
        sessionVersion: { increment: 1 },
      },
    }),
    prisma.backupCode.deleteMany({ where: { userId: user.id } }),
    prisma.apiKey.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } }),
  ]);
  console.log(
    `[reset-2fa] ${e}: 2FA cleared, backup codes deleted, sessions revoked, API keys revoked. Sign in with the password and re-enroll.`,
  );

  if (notify) {
    await getMailer().send(
      e,
      "Two-factor authentication was reset on your PixelDuo account",
      [
        "An operator reset the two-factor authentication on your account, for example because you lost access to your authenticator and backup codes.",
        "",
        "All active sessions and API keys have been revoked. Sign in with your password and set up two-factor authentication again as soon as possible.",
        "",
        "If you did not request this, reply to this email immediately — your password may be compromised.",
      ].join("\n"),
    );
    console.log(`[reset-2fa] notified ${e}`);
  } else {
    console.log("[reset-2fa] owner NOT notified (pass --notify to email them)");
  }
}

main()
  .catch((err) => {
    console.error("[reset-2fa] failed:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
