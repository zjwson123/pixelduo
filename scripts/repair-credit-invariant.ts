// Repair the credit invariant, then let the database enforce it.
//
//   npx tsx scripts/repair-credit-invariant.ts            # report only
//   npx tsx scripts/repair-credit-invariant.ts --fix      # repair, then print
//
// Two rules are supposed to hold at all times (lib/ledger.ts):
//
//   User.credits == SUM(CreditGrant.remaining)
//   0 <= CreditGrant.remaining <= CreditGrant.amount
//
// They were application-only until migration
// 20260926120000_credit_grant_invariant_check added them as a CHECK … NOT VALID
// — enforced on every future write, with the existing rows left unscanned so the
// migration could not fail on a table that was already broken. This script is
// the other half: it finds the rows that predate the rule (a manual insert, a
// benchmark, a bug fixed since), reports exactly what is wrong per account, and
// with --fix brings those accounts back to a consistent state.
//
// What --fix does, per account:
//   - clamps each grant's remaining into [0, amount] (a row with remaining >
//     amount is credits that were never granted: the only way to reach it is a
//     refund of a consumption that was already refunded, and honouring it would
//     mint the difference out of nothing);
//   - sets User.credits to the post-clamp SUM(remaining), and writes ONE ADMIN
//     ledger entry carrying the delta and the reason, so the change is visible
//     in the account's own history rather than being a silent column update.
//
// It is idempotent and reports nothing to do on a healthy database. Run it
// before VALIDATE CONSTRAINT (docs/deploy.md).
import { PrismaClient, Prisma } from "@prisma/client";

const prisma = new PrismaClient();
const fix = process.argv.includes("--fix");

interface Row {
  id: string;
  userId: string;
  email: string;
  amount: number;
  remaining: number;
}

async function main() {
  // 1. Rows that violate 0 <= remaining <= amount.
  const bad = await prisma.$queryRaw<Row[]>(
    Prisma.sql`SELECT g.id, g."userId", u.email, g.amount, g.remaining
      FROM "CreditGrant" g JOIN "User" u ON u.id = g."userId"
      WHERE g.remaining < 0 OR g.remaining > g.amount
      ORDER BY u.email, g.id`,
  );
  // 2. Accounts whose balance column disagrees with their rows.
  const drifted = await prisma.$queryRaw<Array<{ userId: string; email: string; credits: number; sum: bigint }>>(
    Prisma.sql`SELECT u.id AS "userId", u.email, u.credits, COALESCE(SUM(g.remaining), 0)::bigint AS sum
      FROM "User" u LEFT JOIN "CreditGrant" g ON g."userId" = u.id
      GROUP BY u.id, u.email, u.credits
      HAVING u.credits <> COALESCE(SUM(g.remaining), 0)
      ORDER BY u.email`,
  );

  if (!bad.length && !drifted.length) {
    console.log("credit invariant OK — nothing to repair");
    console.log(
      "the CHECK is a full guarantee once validated: ALTER TABLE \"CreditGrant\" VALIDATE CONSTRAINT \"CreditGrant_remaining_range\";",
    );
    return;
  }

  console.log(`${bad.length} grant row(s) out of range, ${drifted.length} account(s) with a drifted balance:`);
  for (const r of bad) {
    console.log(`  grant ${r.id} ${r.email}: remaining ${r.remaining} (amount ${r.amount})`);
  }
  for (const d of drifted) {
    console.log(`  balance ${d.email}: User.credits ${d.credits} vs rows ${d.sum}`);
  }

  if (!fix) {
    console.log("\nre-run with --fix to repair (idempotent; reports nothing on a healthy database)");
    return;
  }

  const userIds = [...new Set([...bad.map((b) => b.userId), ...drifted.map((d) => d.userId)])];
  for (const userId of userIds) {
    await prisma.$transaction(async (tx) => {
      // Lock this account's grants in the canonical order so a concurrent
      // spend/refund/expiry serializes with the repair instead of being
      // overwritten by it.
      const rows = await tx.$queryRaw<Array<{ id: string; amount: number; remaining: number }>>(
        Prisma.sql`SELECT id, amount, remaining FROM "CreditGrant"
          WHERE "userId" = ${userId}
          ORDER BY id
          FOR UPDATE`,
      );
      let clamped = 0;
      for (const r of rows) {
        const next = Math.max(0, Math.min(r.remaining, r.amount));
        if (next === r.remaining) continue;
        await tx.creditGrant.update({ where: { id: r.id }, data: { remaining: next } });
        clamped += Math.abs(r.remaining - next);
        console.log(`  fixed grant ${r.id}: remaining ${r.remaining} → ${next}`);
      }
      const after = await tx.creditGrant.aggregate({ where: { userId }, _sum: { remaining: true } });
      const sum = after._sum.remaining ?? 0;
      const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { credits: true, email: true } });
      const delta = sum - user.credits;
      if (delta === 0) return;
      // Through the ledger, not a bare column write: the delta and its reason
      // belong in the account's history (balanceAfter is the post-write value,
      // which is what ADMINS and the /ledger view read).
      await tx.user.update({ where: { id: userId }, data: { credits: sum } });
      await tx.ledgerEntry.create({
        data: {
          userId,
          type: "ADMIN",
          creditsDelta: delta,
          balanceAfter: sum,
          refType: "none",
          refId: null,
          note:
            `operator repair of the credit invariant (${clamped} credit(s) clamped out of grants): ` +
            "the balance column now equals the sum of this account's grant rows",
        },
      });
      console.log(`  fixed balance ${user.email}: ${user.credits} → ${sum} (delta ${delta})`);
    });
  }

  const left = await prisma.$queryRaw<Array<{ n: bigint }>>(
    Prisma.sql`SELECT COUNT(*)::bigint AS n FROM "CreditGrant" WHERE remaining < 0 OR remaining > amount`,
  );
  console.log(`\ndone — ${left[0].n} out-of-range row(s) left`);
  console.log(
    'now make it a full guarantee: ALTER TABLE "CreditGrant" VALIDATE CONSTRAINT "CreditGrant_remaining_range";',
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
