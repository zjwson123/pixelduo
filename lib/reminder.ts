import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { dbNow } from "./ledger";
import { sendCreditExpiryEmail } from "./mail";
import { captureError } from "./observability";

// Ascending so `find` picks the smallest bucket >= daysLeft (e.g. 2 → 3).
const BUCKETS = [1, 3, 7] as const;
const DAY_MS = 24 * 60 * 60 * 1000;

// Send at most one reminder per grant per bucket (7/3/1 days before expiry) for
// expiring paid credits. Deduplicated by CreditReminder(grantId, daysBefore).
// Failure to send never blocks the cron.
//
// The source list matches listExpiringCredits (lib/credits.ts) exactly: pass 28
// rolled ROLLOVER and REFUND into the in-app banner and left this mail behind,
// so a 30% carryover or a REFUND replacement grant — both spendable and both
// expiring, the latter minted exactly when the customer is owed something —
// was advertised in the workbench and silently destroyed for anyone not
// looking at it (probed: banner listed three sources, the mail only PURCHASE).
// Optional test scope. The sweep is GLOBAL by design (every user's expiring
// credits), but two test files call it concurrently and each asserts about its
// own user's mail — with a global sweep, the other file's run can claim this
// file's grants and send through ITS mailer, so neither file could tell "my
// mail" from "nobody's mail" deterministically (pass 32; the failure surfaced
// as an intermittent red suite whose message named neither file). Production
// (`scripts/remind.ts`) passes no scope and is unchanged.
export async function sendExpiryReminders(scope?: { userId?: string }): Promise<number> {
  // The DATABASE's clock (see listExpiringCredits): a mail that says "1 day
  // left" is a claim about the deadline the spend path and the expiry sweep
  // enforce, and those run on the database's clock.
  const now = await dbNow(prisma);
  const horizon = new Date(now.getTime() + 8 * DAY_MS);
  const grants = await prisma.creditGrant.findMany({
    where: {
      ...(scope?.userId ? { userId: scope.userId } : {}),
      remaining: { gt: 0 },
      // Lower bound too: a grant that already expired but has not been swept
      // yet must not be mailed as "1 day left" (Math.max(1, …) below pins the
      // bucket, so nothing else filters it out).
      expiresAt: { not: null, gt: now, lte: horizon },
      source: { in: ["PURCHASE", "SUBSCRIPTION", "ROLLOVER", "REFUND"] },
    },
    select: { id: true, userId: true, remaining: true, expiresAt: true },
  });

  let sent = 0;
  for (const g of grants) {
    const daysLeft = Math.max(1, Math.ceil((g.expiresAt!.getTime() - now.getTime()) / DAY_MS));
    const bucket = BUCKETS.find((b) => daysLeft <= b);
    if (!bucket) continue;
    // Claim the reminder BEFORE sending: two overlapping cron runs would
    // otherwise both pass the existence check and the user gets the same
    // reminder twice. The unique (grantId, daysBefore) row is the claim; a
    // failed send releases it so the next run retries.
    //
    // The claim and the account's liveness are ONE transaction that locks the
    // User row FOR KEY SHARE (pass 62). CreditReminder has no foreign key to
    // User (so it survives operator row changes by design), which also meant
    // the window between the old findUnique and the INSERT could straddle an
    // erasure: the erasure deleted the reminders it could see and then the
    // user, and this INSERT committed afterwards — a permanent row (and a
    // mail to the erased address) for an account that was promised deleted.
    // FOR KEY SHARE conflicts with the erasure's final User FOR UPDATE, so the
    // two serialize: whichever commits first, the other sees its result.
    let email: string | null = null;
    try {
      email = await prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<Array<{ email: string }>>(
          Prisma.sql`SELECT email FROM "User" WHERE id = ${g.userId} FOR KEY SHARE`,
        );
        if (!rows[0]) return null;
        await tx.creditReminder.create({
          data: { grantId: g.id, userId: g.userId, daysBefore: bucket },
        });
        return rows[0].email;
      });
    } catch {
      continue; // already claimed by a concurrent run, or the account is gone
    }
    if (!email) continue;
    // The claim guarantees the account existed at commit time, but the SMTP
    // send below is outside the transaction and erasure can land between them.
    // Re-check before handing the address to the mailer; the residue row, if
    // the erasure ran in this gap, is removed by the erasure's own sweep (it
    // deletes reminders before the User row).
    const stillExists = await prisma.user.findUnique({
      where: { id: g.userId },
      select: { id: true },
    });
    if (!stillExists) {
      await prisma.creditReminder
        .deleteMany({ where: { grantId: g.id, daysBefore: bucket } })
        .catch(() => undefined);
      continue;
    }
    try {
      await sendCreditExpiryEmail(email, bucket, g.remaining);
      sent += 1;
    } catch (e) {
      await prisma.creditReminder
        .deleteMany({ where: { grantId: g.id, daysBefore: bucket } })
        .catch(() => undefined);
      captureError(e, { grantId: g.id, userId: g.userId, daysBefore: bucket });
    }
  }
  return sent;
}
