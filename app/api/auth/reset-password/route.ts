import bcrypt from "bcryptjs";
import { z } from "zod";
import {
  enforceRateLimit,
  fail,
  ok,
  parseJsonBody,
  passwordWithinBcrypt,
  readBodyCapped,
  zodMessage,
  tooLarge,
  MAX_PASSWORD_BYTES,
} from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { consumeToken, previewToken } from "@/lib/tokens";
import { clearLoginFailures } from "@/lib/login-guard";
import { sendPasswordChangedEmail } from "@/lib/mail";
import { captureError } from "@/lib/observability";

const schema = z.object({
  token: z.string().min(20).max(200),
  // Same bcrypt byte limit as registration (see MAX_PASSWORD_BYTES): a reset is
  // the other path where a NEW password is chosen, and accepting one the
  // algorithm cannot store would reintroduce the silent truncation.
  password: z
    .string()
    .min(8)
    .max(100)
    .refine(passwordWithinBcrypt, {
      message: `must be at most ${MAX_PASSWORD_BYTES} bytes (UTF-8) — bcrypt stores only the first ${MAX_PASSWORD_BYTES} bytes`,
    }),
});

export async function POST(req: Request) {
  try {
    const limited = await enforceRateLimit(req, "reset", 10, 60_000);
    if (limited) return limited;
    const bodyRaw = await readBodyCapped(req, 8 * 1024);
    if ("tooLarge" in bodyRaw) return tooLarge();
    const body = schema.parse(parseJsonBody(bodyRaw.raw));
    // Preview BEFORE hashing (an invalid token must not buy a bcrypt compare),
    // and spend the single use in the SAME transaction as the state change it
    // authorizes (pass 41, the shape pass 39 gave verify-email). The token used
    // to be consumed in its own transaction first: a Prisma timeout, a
    // deadlock, or any failure between the two burned the link and left the
    // password unchanged, so the user had to request another mail — and the
    // account owner's only recovery path was the one that just failed.
    const preview = await previewToken("reset-password", body.token);
    if (!preview.ok || !preview.email) return fail(new Error("invalid-token"));
    const user = await prisma.user.findUnique({ where: { email: preview.email } });
    if (!user) return fail(new Error("invalid-token"));
    const passwordHash = await bcrypt.hash(body.password, 10);
    // Bump sessionVersion so all previously issued JWTs are rejected, and
    // revoke API keys too: a password reset means the account may be
    // compromised, and the explicit revoke is the belt to the version stamp's
    // braces (pass 25's ApiKey.sessionVersion check closes the mint-races-a-
    // revoke ordering; this flip makes the row itself dead, immediately).
    await prisma.$transaction(async (tx) => {
      // Re-checks expiry and the single-use CAS under the transaction: a
      // concurrent reset with the same link either waits here and loses the
      // CAS, or wins before this transaction started, in which case the
      // preview above was stale and this refuses rather than writing twice.
      const result = await consumeToken("reset-password", body.token, tx);
      if (!result.ok || result.email !== user.email) throw new Error("invalid-token");
      await tx.user.update({
        where: { id: user.id },
        data: { passwordHash, sessionVersion: { increment: 1 } },
      });
      await tx.apiKey.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
      // Retire every OTHER live link for this address — reset siblings AND any
      // outstanding verify-email link. createToken only invalidates siblings
      // older than ROTATION_GRACE_MS (30 min), and that grace exists so a
      // re-request cannot invalidate the mail the owner is reading — it must
      // not survive a COMPLETED reset. Without this, a sibling link issued
      // <30 min earlier (still valid for its full 1h TTL) keeps working after
      // the reset, which is exactly the credential the reset-and-revoke
      // remediation is aimed at: anyone who read the mailbox once (before
      // losing that access) holds a valid re-takeover link for up to an hour
      // after the victim's own reset. A completed reset is the strongest
      // signal the account state has moved on, so no outstanding link should
      // survive it.
      //
      // verify-email is the second link purpose because it is the second way
      // in: consuming one requires the account password, but it is a
      // mailbox-independent bearer artifact (a forwarded mail, a MAIL_DEV_MODE
      // container log) that stays live for its full 24h TTL across the reset —
      // the reset exists for the case where the mailbox was compromised once
      // and not trusted any more, and this link is that same mailbox's residue.
      // An owner who still needs to verify can request a fresh link from a
      // session (unverified accounts can sign in).
      await tx.verificationToken.updateMany({
        where: {
          email: user.email,
          purpose: { in: ["reset-password", "verify-email"] },
          consumedAt: null,
        },
        data: { consumedAt: new Date() },
      });
    });
    // The owner learns that their credential moved, in the mailbox the reset
    // link came from — the one place a silent takeover would otherwise have no
    // witness (pass 33; the 2FA routes mail for the same reason). Delivery is
    // reported but not fatal: the reset is already committed, and a broken SMTP
    // relay must not turn a successful reset into a 500 that skips the lockout
    // clear below (the owner would then still be locked out by junk passwords).
    try {
      await sendPasswordChangedEmail(user.email);
    } catch (e) {
      captureError(e, { scope: "reset-password-notice" });
    }
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
