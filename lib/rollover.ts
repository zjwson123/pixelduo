import { prisma } from "./prisma";
import { cycleUsage, ROLLOVER_RATE } from "./ledger";

// Commercial billing semantics:
// - A paid plan is valid for one month (planRenewsAt). The 30% carryover of
//   unused quota is granted at RENEWAL time (see fulfillOrder in ledger.ts),
//   valid only for the following cycle.
// - When a cycle ends without renewal, the plan downgrades to free and the
//   leftover SUBSCRIPTION/ROLLOVER grants are swept by the EXPIRE job.
//   This job must run before scripts/expire.ts in the same pass.

export { cycleUsage, ROLLOVER_RATE } from "./ledger";

export async function downgradeExpiredPlans(): Promise<number> {
  const due = await prisma.user.findMany({
    where: { plan: { not: "free" }, planRenewsAt: { lte: new Date() } },
    select: { id: true },
  });
  let total = 0;
  for (const u of due) {
    // updateMany re-checks planRenewsAt so a concurrent renewal cannot be
    // downgraded after it just extended the cycle.
    const res = await prisma.user.updateMany({
      where: { id: u.id, plan: { not: "free" }, planRenewsAt: { lte: new Date() } },
      data: { plan: "free", planRenewsAt: null },
    });
    total += res.count;
  }
  return total;
}

// Backwards-compatible name for cron scripts.
export async function runRollover(): Promise<number> {
  return downgradeExpiredPlans();
}
