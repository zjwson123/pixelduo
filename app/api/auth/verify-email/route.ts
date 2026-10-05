import bcrypt from "bcryptjs";
import { z } from "zod";
import { ApiError, enforceRateLimit, fail, ok, parseJsonBody, readBodyCapped } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { hasUsablePassword } from "@/lib/auth";
import { signupBonus } from "@/lib/ledger";
import { previewToken, consumeToken } from "@/lib/tokens";
import { reserveLoginAttempt, refundLoginFailures, alertLoginAbuse, reauthIp } from "@/lib/login-guard";

const schema = z.object({
  token: z.string().min(20).max(200),
  password: z.string().max(100).optional(),
});

export async function POST(req: Request) {
  try {
    const limited = await enforceRateLimit(req, "verify", 10, 60_000);
    if (limited) return limited;
    const bodyRaw = await readBodyCapped(req, 8 * 1024);
    if ("tooLarge" in bodyRaw) return new Response("payload too large", { status: 413 });
    const body = schema.parse(parseJsonBody(bodyRaw.raw));
    // Preview first, so a mistyped password does not burn the single use.
    const preview = await previewToken("verify-email", body.token);
    if (!preview.ok || !preview.email) return fail(new Error("invalid-token"));

    const user = await prisma.user.findUnique({ where: { email: preview.email } });
    if (!user) return fail(new Error("invalid-token"));
    // A not-yet-verified account holding a real password must prove it here.
    // The link proves control of the MAILBOX, which is not the same person as
    // the one who typed the password: POST /api/register accepts any address
    // and stores whatever password it is given, so an attacker can pre-register
    // a victim's address with a password they know and wait for the curious
    // click. That click used to activate the account outright — after which the
    // OAuth pre-hijack guard no longer applied (the account was "verified", so
    // the victim's own Google sign-in landed in the attacker's account with the
    // attacker's password still working) and the attacker held a verified
    // identity in someone else's name. Requiring both halves binds the account
    // to one person: the mailbox owner has the link, the registrant has the
    // password. A victim who cannot supply it is not stranded — a password
    // reset rotates the credential, which is exactly the right move for them.
    if (!user.emailVerified && hasUsablePassword(user.passwordHash)) {
      const given = body.password ?? "";
      // The compare reserves on the login guard, like every other password
      // compare in the system (lib/login-guard.ts: "one password, one budget,
      // whoever asks for it"). This was the sixth and last one that did not:
      // the per-IP bucket at the top is a rate limit, not a counter, so a live
      // verify link — a forwarded or archived mail, a container log under
      // MAIL_DEV_MODE, or a link that predates the owner's completed password
      // reset — was an unmetered bcrypt oracle: ~10 guesses/minute per address,
      // unbounded across addresses, with no cumulative cap, no alert to the
      // owner and no lockout that could ever engage. Correct password refunds
      // the reservation, exactly as on the login path.
      const ip = reauthIp(req);
      const attempt = await reserveLoginAttempt(user.email, ip);
      if (!attempt.allowed) return fail(new ApiError(429, "rate-limited"));
      if (!given || !(await bcrypt.compare(given, user.passwordHash))) {
        // Fire-and-forget: the owner hears about a distributed grind, and the
        // response time does not depend on SMTP (same contract as authorize).
        void alertLoginAbuse(user.email).catch(() => undefined);
        return fail(new Error("invalid-password"));
      }
      await refundLoginFailures(user.email, ip);
    }

    // Single-use CAS. Losing it means a concurrent request consumed the token.
    const consumed = await consumeToken("verify-email", body.token);
    if (!consumed.ok) return fail(new Error("invalid-token"));

    // updateMany guards against double-verification granting the bonus twice.
    const updated = await prisma.user.updateMany({
      where: { id: user.id, emailVerified: null },
      data: { emailVerified: new Date() },
    });
    if (updated.count === 1) {
      await signupBonus(user.id);
      return ok({ verified: true, credits: 30 });
    }
    return ok({ verified: true, alreadyVerified: true });
  } catch (e) {
    if (e instanceof z.ZodError) return fail(new Error("invalid-token"));
    return fail(e);
  }
}
