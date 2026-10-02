import { z } from "zod";
import { ApiError, enforceUserRateLimit, fail, ok, parseJsonBody, readBodyCapped, requireVerifiedUser, zodMessage } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { passwordReauthRefusal } from "@/lib/auth";
import { generateTwoFactorSetup } from "@/lib/twofa";
import {
  reservePasswordReauth,
  alertPasswordReauthAbuse,
  refundPasswordReauth,
} from "@/lib/login-guard";
import bcrypt from "bcryptjs";

const schema = z.object({ password: z.string().min(1).max(100) });

// Step 1 of enabling 2FA: create a secret (stored as pending until confirmed).
// Password re-auth: the returned secret lets a session thief enable 2FA with
// their own authenticator and lock the real owner out of the account.
export async function POST(req: Request) {
  try {
    const userId = await requireVerifiedUser();
    // Each call overwrites totpPendingSecret. Account-keyed only — the per-IP
    // leg it used to carry first let any one account hold the bucket full and
    // refuse 2FA ENROLMENT to every neighbour behind the same egress.
    const limited = await enforceUserRateLimit(userId, "2fa-setup", 5, 60_000);
    if (limited) return fail(limited);
    const bodyRaw = await readBodyCapped(req, 8 * 1024);
    if ("tooLarge" in bodyRaw) return new Response("payload too large", { status: 413 });
    const body = schema.parse(parseJsonBody(bodyRaw.raw));
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { email: true, totpEnabled: true, passwordHash: true },
    });
    if (user.totpEnabled) return ok({ alreadyEnabled: true });
    const refusal = passwordReauthRefusal(user.passwordHash);
    if (refusal) return fail(refusal);
    // Reserve on the LOGIN guard's counters before the compare (see
    // lib/login-guard.ts): this is a password oracle, and the per-minute
    // buckets above are not a cumulative brake.
    const attempt = await reservePasswordReauth(user.email, req);
    if (!attempt.allowed) return fail(new ApiError(429, "rate-limited"));
    if (!(await bcrypt.compare(body.password, user.passwordHash))) {
      await alertPasswordReauthAbuse(user.email);
      return fail(new Error("invalid-password"));
    }
    await refundPasswordReauth(user.email, req);
    const setup = await generateTwoFactorSetup(user.email);
    await prisma.user.update({ where: { id: userId }, data: { totpPendingSecret: setup.secret } });
    return ok(setup);
  } catch (e) {
    if (e instanceof z.ZodError) return fail(zodMessage(e));
    return fail(e);
  }
}
