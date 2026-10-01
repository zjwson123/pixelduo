import { z } from "zod";
import { Prisma } from "@prisma/client";
import { zodMessage, requireUserId, ok, fail, enforceUserRateLimit, readBodyCapped, ApiError } from "@/lib/api";
import { prisma, withDeadlockRetry } from "@/lib/prisma";
import { passwordReauthRefusal } from "@/lib/auth";
import { GRANT_LOCK_ORDER } from "@/lib/ledger";
import { deleteObjectsBounded } from "@/lib/storage";
import { checkpointKeys } from "@/lib/queue";
import { ADMIN_GUARD_LOCK, assertAnotherAdminRemains } from "@/lib/admin";
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
  confirm: z.literal(true),
  // Irreversible erasure requires re-authentication: a hijacked cookie alone
  // must not destroy the account (2FA-enabled accounts need the 2nd factor).
  password: z.string().min(1).max(100),
  token: z.string().min(6).max(20).optional(),
  backupCode: z.string().min(8).max(40).optional(),
});

// GDPR / PIPL erasure: deletes the account and all related data + stored image files.
export async function POST(req: Request) {
  try {
    const userId = await requireUserId();
    // Re-auth brute force (password + TOTP/backup-code guesses) gets the same
    // ACCOUNT-keyed limit as the dedicated 2FA endpoints. The per-IP leg this
    // used to charge first was pure collateral: five wrong-password bodies from
    // any one account refused the erasure of every co-tenant on that egress.
    const limited = await enforceUserRateLimit(userId, "account-delete", 5, 60_000);
    if (limited) return fail(limited);
    // Cumulative brake (lib/twofa.ts), consulted before the password and the
    // second factor are compared: erasure is the one irreversible second-factor
    // check, and the account is refused entirely while a grind is in progress.
    if (await isTwoFactorLocked(userId)) return fail(new ApiError(429, TWOFA_LOCKED_ERROR));
    const bodyRaw = await readBodyCapped(req, 8 * 1024);
    if ("tooLarge" in bodyRaw) return new Response("payload too large", { status: 413 });
    const body = schema.parse(JSON.parse(bodyRaw.raw));
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { email: true, passwordHash: true, totpSecret: true, totpEnabled: true, role: true },
    });
    const refusal = passwordReauthRefusal(user.passwordHash);
    if (refusal) return fail(refusal);
    // Reserve on the LOGIN guard's counters before the compare
    // (lib/login-guard.ts). Erasure is irreversible, so the password it asks for
    // must be as expensive to guess here as it is on the login endpoint — the
    // per-minute buckets above bound the rate, not the campaign.
    const attempt = await reservePasswordReauth(user.email, req);
    if (!attempt.allowed) return fail(new ApiError(429, "rate-limited"));
    if (!(await bcrypt.compare(body.password, user.passwordHash))) {
      await alertPasswordReauthAbuse(user.email);
      return fail(new Error("invalid-password"));
    }
    await refundPasswordReauth(user.email, req);
    // The last admin may not erase itself: /admin would become unreachable by
    // anyone (both admin-side mutations refuse to target the caller, so no
    // in-app path could mint a replacement) and recovery would need the
    // operator script. The invariant is enforced in three other places —
    // admin/users/[id] DELETE, the role route, and scripts/promote-admin.ts —
    // and self-service erasure is the fourth way to delete a User row. The
    // `cannot-` prefix is what fail() maps to a 400 (api-status.test.ts).
    if (user.role === "admin") {
      const admins = await prisma.user.count({ where: { role: "admin" } });
      if (admins <= 1) return fail(new Error("cannot-delete-last-admin: promote another admin first"));
    }
    // The second factor is demanded only from accounts that have one, and it is
    // demanded HERE rather than in the schema because the schema cannot see the
    // account. Requiring it unconditionally was worse than useless: for a
    // non-2FA account the token was never verified (this branch is not taken),
    // so any 6+ character string passed — while the documented erasure body
    // (`{confirm,password}`, docs/compliance/privacy.md) was rejected as
    // invalid input, making the documented call impossible for those users.
    if (user.totpEnabled && user.totpSecret) {
      if (!body.token && !body.backupCode) return fail(new Error("2fa-code-required"));
      // The TOTP branch claims the code (a code observed inside its ±1 step
      // window must not also be able to erase the account); backup codes are
      // already single-use in the database.
      const ok2 = body.token
        ? verifyTotp(user.totpSecret, body.token) && (await claimTotpCode(userId, body.token))
        : await useBackupCode(userId, body.backupCode!);
      if (!ok2) {
        await recordTwoFactorFailure(userId);
        return fail(new Error("invalid-code"));
      }
      await clearTwoFactorFailures(userId);
    }
    // Generated outputs AND user-uploaded reference images (Job.refImageKey —
    // for i2v/edit workflows these can be personal photos, the most sensitive
    // files we hold) must both be erased for a true GDPR/PIPL delete. So must
    // the images a job had already persisted into its checkpoint: those have no
    // Image row yet, so nothing else here (or /api/files) can reach them, and
    // they were generated from the user's own prompts.
    const images = await prisma.image.findMany({ where: { userId }, select: { url: true } });
    const jobs = await prisma.job.findMany({
      where: { userId },
      select: { refImageKey: true, images: true, sourceVideoKey: true },
    });
    const refKeys = jobs.map((j) => j.refImageKey).filter((k): k is string => Boolean(k));
    const staged = jobs.flatMap((j) => checkpointKeys(j.images));
    // Job.sourceVideoKey is the OTHER durable pointer to a stored object: an
    // extend job names the clip it continues (app/api/video/route.ts:102), and
    // nothing else in the schema or the code reaches that column — only the
    // worker reads it. Gallery delete removes the Image row first and deletes
    // the blob best-effort, so a single transient failure there would leave the
    // object with no row naming it, and this sweep is the last chance to reach
    // it. Erasure has to collect every pointer the user's own rows hold.
    const sourceKeys = jobs.map((j) => j.sourceVideoKey).filter((k): k is string => Boolean(k));
    await deleteObjectsBounded([
      ...images.map((i) => i.url),
      ...refKeys,
      ...staged,
      ...sourceKeys,
    ]);
    await withDeadlockRetry(() =>
      prisma.$transaction(async (tx) => {
        // Re-checked under a lock held to commit, in the same transaction as the
        // delete. The unlocked count above cannot be the invariant: two admins
        // erasing themselves at the same moment each saw 2 admins and both deletes
        // landed, leaving an install with no admin and no in-app way to mint one
        // (both admin routes refuse to target the caller, so recovery needs host
        // access to scripts/promote-admin.ts).
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ADMIN_GUARD_LOCK})`;
        const current = await tx.user.findUnique({ where: { id: userId }, select: { role: true } });
        if (!current) throw new Error("user-not-found");
        if (current.role === "admin") await assertAnotherAdminRemains(tx, userId);
        // Lock what the cascade below will reach, in the order every writer that
        // can meet this transaction takes it: Order → Job → CreditGrant → User.
        //
        // The grant lock alone was not enough. This transaction reaches the Job
        // and Order rows through the cascade, i.e. AFTER the User row, while the
        // writers that hold those rows take them FIRST: completeJob (Order → Job
        // → User), failJob (Job → grants → User), the refund webhook (Order →
        // grants → User), fulfilOrder (Order → User). An erasure overlapping any
        // of them was therefore still a cycle, and PostgreSQL aborted the erasure
        // (40P01 on `user.delete`, observed in probes against the real failJob
        // and against the webhook's statement pair) — a 500 on the one route
        // whose promise is that the customer can retry. The sweep and the spend
        // path are the two races the previous version did close, which is why the
        // order has to come from the writers rather than from the race that
        // happened to be seen. withDeadlockRetry is the net for the next writer
        // this list does not know about yet.
        //
        // Locking rows the cascade will delete is idempotent, and the cost is
        // bounded by the account's own row count (a 20k-grant / 2k-job account
        // measured 26 ms, against the 5 s transaction timeout).
        await tx.$queryRaw(Prisma.sql`SELECT id FROM "Order" WHERE "userId" = ${userId} ORDER BY id FOR UPDATE`);
        await tx.$queryRaw(Prisma.sql`SELECT id FROM "Job" WHERE "userId" = ${userId} ORDER BY id FOR UPDATE`);
        await tx.$queryRaw(
          Prisma.sql`SELECT id FROM "CreditGrant" WHERE "userId" = ${userId} ${GRANT_LOCK_ORDER} FOR UPDATE`,
        );
        await tx.backupCode.deleteMany({ where: { userId } });
        await tx.verificationToken.deleteMany({ where: { userId } });
        await tx.creditReminder.deleteMany({ where: { userId } });
        // ApiKey has no FK relation (by design, hash-only table), so it needs an
        // explicit wipe or key metadata survives the erasure request.
        await tx.apiKey.deleteMany({ where: { userId } });
        await tx.user.delete({ where: { id: userId } });
      }),
    );
    return ok({ deleted: true });
  } catch (e) {
    if (e instanceof z.ZodError) return fail(zodMessage(e));
    return fail(e);
  }
}
