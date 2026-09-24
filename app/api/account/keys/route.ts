import { z } from "zod";
import { zodMessage, requireVerifiedUser, ok, fail, enforceRateLimit, enforceUserRateLimit, readBodyCapped, ApiError } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { passwordReauthRefusal } from "@/lib/auth";
import { createApiKey } from "@/lib/apikey";
import {
  verifyTotp,
  useBackupCode,
  isTwoFactorLocked,
  recordTwoFactorFailure,
  clearTwoFactorFailures,
  claimTotpCode,
  TWOFA_LOCKED_ERROR,
} from "@/lib/twofa";
import {
  reservePasswordReauth,
  alertPasswordReauthAbuse,
  refundPasswordReauth,
} from "@/lib/login-guard";
import bcrypt from "bcryptjs";

const schema = z.object({
  name: z.string().min(1).max(60).optional(),
  password: z.string().min(1).max(100),
  token: z.string().min(6).max(20).optional(),
  backupCode: z.string().min(8).max(40).optional(),
});

// List the current user's API keys (display info only — raw key is never
// retrievable after creation).
export async function GET() {
  try {
    const userId = await requireVerifiedUser();
    // The one authenticated read left without its own budget when its siblings
    // got one: each call costs a sessionVersion read plus a key scan, and the
    // only thing bounding it was the middleware's per-IP bucket, which IP
    // rotation lifts. Same treatment as ledger / gallery / orders / me.
    const listLimited = await enforceUserRateLimit(userId, "apikey-list", 60, 60_000);
    if (listLimited) return fail(listLimited);
    const keys = await prisma.apiKey.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      select: { id: true, name: true, prefix: true, revokedAt: true, lastUsedAt: true, createdAt: true },
    });
    return ok({ keys });
  } catch (e) {
    return fail(e);
  }
}

const MAX_ACTIVE_KEYS = 10;

// Minting a key needs re-authentication (same bar as account deletion): a
// stolen session cookie alone must not be able to mint a pd_live_ key that
// outlives the session and never consults sessionVersion.
export async function POST(req: Request) {
  try {
    const userId = await requireVerifiedUser();
    const limited = await enforceRateLimit(req, "apikey-create", 5, 60_000);
    if (limited) return limited;
    // Per-account cap alongside the per-IP one: this endpoint is a password +
    // TOTP re-auth gate, so guesses spread across rotating IPs must not
    // dilute the limit (same treatment as 2fa/disable and account/delete).
    const userLimited = await enforceUserRateLimit(userId, "apikey-create", 5, 60_000);
    if (userLimited) return fail(userLimited);
    // Cumulative brake (lib/twofa.ts) before the password and the second factor
    // are compared: a key outlives sessions and never consults sessionVersion,
    // so this re-auth gate gets the same campaign-level bound as the login step.
    if (await isTwoFactorLocked(userId)) return fail(new ApiError(429, TWOFA_LOCKED_ERROR));
    const bodyRaw = await readBodyCapped(req, 8 * 1024);
    if ("tooLarge" in bodyRaw) return new Response("payload too large", { status: 413 });
    const body = schema.parse(JSON.parse(bodyRaw.raw));
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { email: true, passwordHash: true, totpSecret: true, totpEnabled: true },
    });
    // Reserve on the LOGIN guard's counters before the compare
    // (lib/login-guard.ts): what this route mints outlives the session and
    // survives every revocation, so a leaked cookie must not be able to grind
    // the password here at 5 guesses/minute with nothing accumulating.
    const refusal = passwordReauthRefusal(user.passwordHash);
    if (refusal) return fail(refusal);
    const attempt = await reservePasswordReauth(user.email, req);
    if (!attempt.allowed) return fail(new ApiError(429, "rate-limited"));
    if (!(await bcrypt.compare(body.password, user.passwordHash))) {
      await alertPasswordReauthAbuse(user.email);
      return fail(new Error("invalid-password"));
    }
    await refundPasswordReauth(user.email, req);
    if (user.totpEnabled && user.totpSecret) {
      // normalizeBackupCode(undefined) would throw a TypeError → masked 500.
      if (!body.token && !body.backupCode) return fail(new Error("2fa-code-required"));
      // The TOTP branch claims the code: a code observed inside its ±1 step
      // window must not also be able to mint a permanent credential.
      const ok2 = body.token
        ? verifyTotp(user.totpSecret, body.token) && (await claimTotpCode(userId, body.token))
        : await useBackupCode(userId, body.backupCode!);
      if (!ok2) {
        await recordTwoFactorFailure(userId);
        return fail(new Error("invalid-code"));
      }
      await clearTwoFactorFailures(userId);
    }
    // Cap active keys: unbounded creation bloats the table and each key adds
    // its own per-key v1 rate budget. Count-then-create is a TOCTOU, so it runs
    // under a per-account advisory lock (same pattern as the job inflight cap):
    // without it N parallel re-auth'd requests all read the same pre-insert
    // count, all pass, and each mints a permanent credential.
    const key = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userId}))`;
      const active = await tx.apiKey.count({ where: { userId, revokedAt: null } });
      if (active >= MAX_ACTIVE_KEYS) {
        throw new Error("too-many-keys: revoke one before creating another");
      }
      return createApiKey(userId, body.name ?? "default", tx);
    });
    return ok({ ...key, note: "copy now — the full key is shown only once" });
  } catch (e) {
    if (e instanceof z.ZodError) return fail(zodMessage(e));
    return fail(e);
  }
}
