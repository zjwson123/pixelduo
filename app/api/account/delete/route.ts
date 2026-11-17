import { z } from "zod";
import { Prisma } from "@prisma/client";
import { ApiError, enforceUserRateLimit, fail, ok, parseJsonBody, readBodyCapped, requireUserIdSession, zodMessage, tooLarge } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { passwordReauthRefusal } from "@/lib/auth";
import { GRANT_LOCK_ORDER } from "@/lib/ledger";
import { eraseUserArtifacts, scrubOperatorReferencesTx } from "@/lib/erasure";
import { captureError } from "@/lib/observability";
import { ADMIN_GUARD_LOCK, assertAnotherAdminRemains } from "@/lib/admin";
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
    const { id: userId, sv } = await requireUserIdSession();
    // Re-auth brute force (password + TOTP/backup-code guesses) gets the same
    // ACCOUNT-keyed limit as the dedicated 2FA endpoints. The per-IP leg this
    // used to charge first was pure collateral: five wrong-password bodies from
    // any one account refused the erasure of every co-tenant on that egress.
    const limited = await enforceUserRateLimit(userId, "account-delete", 5, 60_000);
    if (limited) return fail(limited);
    // Cumulative brake (lib/twofa.ts), consulted before the password and the
    // second factor are compared: erasure is the one irreversible second-factor
    // check, and the account is refused entirely while a grind is in progress.
    const lock = await twoFactorLockStatus(userId);
    if (lock.locked) return fail(new ApiError(429, TWOFA_LOCKED_ERROR, lock.retryAfterSec));
    const bodyRaw = await readBodyCapped(req, 8 * 1024);
    if ("tooLarge" in bodyRaw) return tooLarge();
    const body = schema.parse(parseJsonBody(bodyRaw.raw));
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
    if (!attempt.allowed) return fail(new ApiError(429, "rate-limited", attempt.retryAfterSec));
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
    // they were generated from the user's own prompts. Job.sourceVideoKey is
    // the OTHER durable pointer to a stored object (an extend job names the
    // clip it continues, and only the worker reads that column).
    //
    // eraseUserArtifacts owns the whole sequence (pass 39): every key, a delete
    // whose failures are no longer swallowed, a locked re-read that proves no
    // worker completed an artifact in between, and only then the row deletes.
    // A storage fault now answers 503 with the account intact and retryable,
    // instead of `{deleted:true}` over objects that were still in the bucket
    // with nothing left naming them.
    await eraseUserArtifacts(
      userId,
      {
        lockRows: async (tx) => {
          // Re-checked under a lock held to commit, in the same transaction as the
          // delete. The unlocked count above cannot be the invariant: two admins
          // erasing themselves at the same moment each saw 2 admins and both deletes
          // landed, leaving an install with no admin and no in-app way to mint one
          // (both admin routes refuse to target the caller, so recovery needs host
          // access to scripts/promote-admin.ts).
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ADMIN_GUARD_LOCK})`;
          const current = await tx.user.findUnique({
            where: { id: userId },
            select: { role: true },
          });
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
          // happened to be seen. lib/erasure keeps withDeadlockRetry as the net for
          // the next writer this list does not know about yet.
          //
          // Locking rows the cascade will delete is idempotent, and the cost is
          // bounded by the account's own row count (a 20k-grant / 2k-job account
          // measured 26 ms, against the 5 s transaction timeout). The artifact
          // re-read runs INSIDE this lock: a worker that committed its Image row
          // before the lock is seen and forces one more sweep; one that commits
          // after it blocks and then loses its own CAS because the row is gone.
          await tx.$queryRaw(Prisma.sql`SELECT id FROM "Order" WHERE "userId" = ${userId} ORDER BY id FOR UPDATE`);
          await tx.$queryRaw(Prisma.sql`SELECT id FROM "Job" WHERE "userId" = ${userId} ORDER BY id FOR UPDATE`);
          await tx.$queryRaw(
            Prisma.sql`SELECT id FROM "CreditGrant" WHERE "userId" = ${userId} ${GRANT_LOCK_ORDER} FOR UPDATE`,
          );
          // The User row is locked LAST, the position every money writer uses.
          // Erasure is irreversible and the storage sweep runs INSIDE this
          // transaction (pass 43): a reset-password / revoke-sessions arriving
          // after the top-of-request check must win, and it can only do that by
          // blocking here until the sweep and row deletes commit — otherwise
          // the owner's revocation abandoned the account but left its files
          // already deleted. The version is re-read under this lock; the one
          // observed at the top of the request authorized the password/2FA
          // checks and may have been superseded since.
          await tx.$queryRaw(Prisma.sql`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`);
          const locked = await tx.user.findUnique({
            where: { id: userId },
            select: { sessionVersion: true },
          });
          if (!locked) throw new Error("user-not-found");
          if (locked.sessionVersion !== sv) throw new ApiError(401, "unauthorized");
        },
        deleteRows: async (tx) => {
          await tx.backupCode.deleteMany({ where: { userId } });
          // VerificationToken.userId is nullable, and a token written by an
          // older version of the app (or by a path that had no user row yet)
          // would survive a deleteMany keyed only on it (pass 62). The address
          // arm catches those; it is the account's own address, read from the
          // authenticated user row above.
          await tx.verificationToken.deleteMany({
            where: { OR: [{ userId }, { userId: null, email: user.email }] },
          });
          await tx.creditReminder.deleteMany({ where: { userId } });
          // ApiKey has no FK relation (by design, hash-only table), so it needs an
          // explicit wipe or key metadata survives the erasure request.
          await tx.apiKey.deleteMany({ where: { userId } });
          // PaymentEvent has no FK to Order either (it is the webhook dedupe /
          // audit row, written before an order is always resolvable), so the
          // cascade below would leave the account's whole payment-event trail —
          // provider, event id, order id, amounts — behind a deleted user, with
          // no row left to connect it to. It is the third no-FK table and the
          // only one the erasure still missed (pass 60). The subquery runs
          // before the user delete (the Order rows still name the user), and SQL
          // rather than a bound id list because an account can carry more orders
          // than the 32,767-parameter ceiling.
          await tx.$executeRaw(
            Prisma.sql`DELETE FROM "PaymentEvent" WHERE "orderId" IN (SELECT id FROM "Order" WHERE "userId" = ${userId})`,
          );
          // The no-FK operator references this account left on OTHER accounts'
          // rows — the ledger's actorId, admin grant refIds and feedback's
          // handledBy (pass 61). Only an admin can have written them, and the
          // cascade cannot reach them.
          await scrubOperatorReferencesTx(tx, userId);
          await tx.user.delete({ where: { id: userId } });
        },
      },
      {
        onStorageFailure: (keys) =>
          captureError(new Error("erasure-storage-delete-failed"), {
            scope: "erasure-storage",
            userId,
            failedKeys: keys.length,
          }),
      },
    );
    return ok({ deleted: true });
  } catch (e) {
    if (e instanceof z.ZodError) return fail(zodMessage(e));
    return fail(e);
  }
}
