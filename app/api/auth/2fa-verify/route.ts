import { z } from "zod";
import { ApiError, enforceUserRateLimit, fail, ok, parseJsonBody, readBodyCapped, requirePartialSession, zodMessage, tooLarge } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import {
  verifyTotp,
  useBackupCode,
  createPreAuthToken,
  twoFactorLockStatus,
  recordTwoFactorFailure,
  clearTwoFactorFailures,
  claimTotpCode,
  TWOFA_LOCKED_ERROR,
} from "@/lib/twofa";

const schema = z
  .object({
    token: z.string().min(6).max(20).optional(),
    backupCode: z.string().min(8).max(40).optional(),
  })
  .refine((v) => Boolean(v.token || v.backupCode), { message: "invalid-input" });

// Second login step: validate TOTP / backup code against the partial session,
// then issue a short-lived single-use ticket that authorize() accepts to
// create the real session.
export async function POST(req: Request) {
  try {
    const su = await requirePartialSession();
    if (!su.totpPending) return fail(new ApiError(403, "2fa-required"));
    const userLimited = await enforceUserRateLimit(su.id, "2fa-verify", 5, 60_000);
    if (userLimited) return fail(userLimited);
    // The bucket sits AFTER the session check, and that order is the point: the
    // per-IP leg that used to run first let five anonymous junk bodies
    // ({"token":"123456"}) empty it and hand every legitimate user behind that
    // address `429 rate-limited` with no code ever compared — a second-factor
    // lockout anyone could trigger, per IP, from anywhere. What remains is
    // account-keyed only: an attacker holding a stolen partial session must
    // still grind the code against a 5/min cap, and the work a credential-less
    // caller can do is bounded one layer up by proxy.ts's per-IP auth bucket —
    // the same arrangement every other route relies on, since
    // `requireVerifiedUser` also runs before any route-level limiter.
    //
    // The per-IP leg is gone rather than merely reordered because a partial
    // session is a credential: one attacker's own 2FA-enabled account could
    // still hold `2fa:<egress>` full at 5/min and refuse the second-factor step
    // — i.e. LOGIN — to every co-tenants, indefinitely. A shared source address
    // cannot be held responsible for traffic; the account can.
    // Cumulative brake, consulted before anything is compared: the per-minute
    // limit above bounds a burst, this bounds the campaign (see lib/twofa.ts).
    // It applies to backup codes too — the account is under second-factor
    // attack, so every path that accepts one is closed until it clears.
    const lock = await twoFactorLockStatus(su.id);
    if (lock.locked) return fail(new ApiError(429, TWOFA_LOCKED_ERROR, lock.retryAfterSec));
    const bodyRaw = await readBodyCapped(req, 8 * 1024);
    if ("tooLarge" in bodyRaw) return tooLarge();
    const body = schema.parse(parseJsonBody(bodyRaw.raw));
    const user = await prisma.user.findUnique({
      where: { id: su.id },
      select: { id: true, email: true, totpSecret: true, totpEnabled: true },
    });
    if (!user?.totpEnabled || !user.totpSecret) return fail(new Error("2fa-not-enabled"));

    let ok2 = false;
    if (body.token) {
      // A code stays valid for ±1 step (up to 90s), so the same one could mint a
      // second ticket inside that window — verify first, then claim it, and a
      // replayed code is an invalid code.
      ok2 = verifyTotp(user.totpSecret, body.token) && (await claimTotpCode(user.id, body.token));
    } else if (body.backupCode) {
      ok2 = await useBackupCode(user.id, body.backupCode);
    }
    if (!ok2) {
      await recordTwoFactorFailure(su.id);
      return fail(new Error("invalid-code"));
    }
    await clearTwoFactorFailures(su.id);

    // Stamped with the version this request was authorized under: a revoke or
    // reset arriving before the ticket is redeemed retires it (pass 43).
    const preAuthToken = await createPreAuthToken(user.email, su.sv);
    return ok({ preAuthToken });
  } catch (e) {
    if (e instanceof z.ZodError) return fail(zodMessage(e));
    return fail(e);
  }
}
