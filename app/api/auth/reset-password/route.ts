import bcrypt from "bcryptjs";
import { z } from "zod";
import { enforceRateLimit, fail, ok, parseJsonBody, readBodyCapped, zodMessage } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { consumeToken } from "@/lib/tokens";
import { clearLoginFailures } from "@/lib/login-guard";

const schema = z.object({
  token: z.string().min(20).max(200),
  password: z.string().min(8).max(100),
});

export async function POST(req: Request) {
  try {
    const limited = await enforceRateLimit(req, "reset", 10, 60_000);
    if (limited) return limited;
    const bodyRaw = await readBodyCapped(req, 8 * 1024);
    if ("tooLarge" in bodyRaw) return new Response("payload too large", { status: 413 });
    const body = schema.parse(parseJsonBody(bodyRaw.raw));
    const result = await consumeToken("reset-password", body.token);
    if (!result.ok || !result.email) return fail(new Error("invalid-token"));
    const user = await prisma.user.findUnique({ where: { email: result.email } });
    if (!user) return fail(new Error("invalid-token"));
    const passwordHash = await bcrypt.hash(body.password, 10);
    // Bump sessionVersion so all previously issued JWTs are rejected, and
    // revoke API keys too: a password reset means the account may be
    // compromised, and the explicit revoke is the belt to the version stamp's
    // braces (pass 25's ApiKey.sessionVersion check closes the mint-races-a-
    // revoke ordering; this flip makes the row itself dead, immediately).
    await prisma.$transaction([
      prisma.user.update({
        where: { id: user.id },
        data: { passwordHash, sessionVersion: { increment: 1 } },
      }),
      prisma.apiKey.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } }),
      // Retire every OTHER live reset token for this address. createToken only
      // invalidates siblings older than ROTATION_GRACE_MS (30 min), and that
      // grace exists so a re-request cannot invalidate the mail the owner is
      // reading — it must not survive a COMPLETED reset. Without this, a
      // sibling link issued <30 min earlier (still valid for its full 1h TTL)
      // keeps working after the reset, which is exactly the credential the
      // reset-and-revoke remediation is aimed at: anyone who read the mailbox
      // once (before losing that access) holds a valid re-takeover link for up
      // to an hour after the victim's own reset. A completed reset is the
      // strongest signal the account state has moved on, so no outstanding
      // link should survive it.
      prisma.verificationToken.updateMany({
        where: { email: user.email, purpose: "reset-password", consumedAt: null },
        data: { consumedAt: new Date() },
      }),
    ]);
    // Proof of mailbox ownership is also the documented recovery path out of a
    // brute-force lockout: without this, junk passwords from a few sources
    // would keep the real owner out even after they rotated their password.
    await clearLoginFailures(user.email);
    return ok({ reset: true });
  } catch (e) {
    if (e instanceof z.ZodError) return fail(zodMessage(e));
    return fail(e);
  }
}
