import { z } from "zod";
import { Prisma } from "@prisma/client";
import { ApiError, enforceUserRateLimit, fail, ok, parseJsonBody, readBodyCapped, requireVerifiedUser, requireVerifiedUserSession, zodMessage, tooLarge } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { passwordReauthRefusal } from "@/lib/auth";
import { createApiKey } from "@/lib/apikey";
import {
  verifyTotp,
  useBackupCode,
  twoFactorLockStatus,
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
    const { id: userId, sv } = await requireVerifiedUserSession();
    // Per-account cap, and the only leg: this endpoint is a password + TOTP
    // re-auth gate, so what must not be diluted is the budget for guessing on
    // THIS account — which is what the account key does. The per-IP leg it also
    // carried was spent before any credential was examined, so a neighbour's
    // traffic (or one account grinding its own password) refused key minting to
    // everyone else behind the same egress.
    const userLimited = await enforceUserRateLimit(userId, "apikey-create", 5, 60_000);
    if (userLimited) return fail(userLimited);
    // Cumulative brake (lib/twofa.ts) before the password and the second factor
    // are compared: a key outlives sessions and never consults sessionVersion,
    // so this re-auth gate gets the same campaign-level bound as the login step.
    const lock = await twoFactorLockStatus(userId);
    if (lock.locked) return fail(new ApiError(429, TWOFA_LOCKED_ERROR, lock.retryAfterSec));
    const bodyRaw = await readBodyCapped(req, 8 * 1024);
    if ("tooLarge" in bodyRaw) return tooLarge();
    const body = schema.parse(parseJsonBody(bodyRaw.raw));
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
    if (!attempt.allowed) return fail(new ApiError(429, "rate-limited", attempt.retryAfterSec));
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
      // Serialize with account erasure before minting (pass 44). ApiKey has no
      // foreign key to User on purpose (it is a hash-only table), so this INSERT
      // is invisible to the erasure transaction's locks: an erasure that has
      // already deleted the account's keys but not yet the User row could commit
      // without this one, leaving key metadata behind for an account that no
      // longer exists — a GDPR/PIPL completeness hole. FOR KEY SHARE conflicts
      // with the erasure's User FOR UPDATE (it waits, then sees no row and
      // refuses) and deliberately does NOT conflict with the ordinary
      // FOR NO KEY UPDATE taken by every credits/plan write, so the money path
      // gains no contention.
      const owner = await tx.$queryRaw<Array<{ id: string }>>(
        Prisma.sql`SELECT id FROM "User" WHERE id = ${userId} FOR KEY SHARE`,
      );
      if (owner.length === 0) throw new ApiError(401, "unauthorized");
      // Re-read the version INSIDE the transaction and stamp it on the row. The
      // gate at the top of this handler cannot see a revocation that commits
      // while we are here, and a key minted by a session revoked mid-request
      // would outlive the reset its owner just performed — a permanent
      // pd_live_ credential, which is the one thing this route's re-auth exists
      // to prevent. The stamp makes the ordering irrelevant: a later bump
      // invalidates this key whenever it commits (authenticateApiKey).
      const fresh = await tx.user.findUniqueOrThrow({
        where: { id: userId },
        select: { sessionVersion: true },
      });
      if (fresh.sessionVersion !== sv) throw new ApiError(401, "unauthorized");
      const active = await tx.apiKey.count({ where: { userId, revokedAt: null } });
      if (active >= MAX_ACTIVE_KEYS) {
        throw new Error("too-many-keys: revoke one before creating another");
      }
      return createApiKey(userId, body.name ?? "default", fresh.sessionVersion, tx);
    });
    return ok({ ...key, note: "copy now — the full key is shown only once" });
  } catch (e) {
    if (e instanceof z.ZodError) return fail(zodMessage(e));
    return fail(e);
  }
}
