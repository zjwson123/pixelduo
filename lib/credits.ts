import { prisma } from "./prisma";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ExpiringCredit {
  id: string;
  source: string;
  remaining: number;
  expiresAt: Date;
  daysLeft: number;
}

// Grants whose remaining credits expire within the horizon (for the
// workbench banner / retention nudges). Only paid sources count.
export async function listExpiringCredits(userId: string, days = 14): Promise<ExpiringCredit[]> {
  const horizon = new Date(Date.now() + days * DAY_MS);
  const grants = await prisma.creditGrant.findMany({
    where: {
      userId,
      remaining: { gt: 0 },
      expiresAt: { not: null, lte: horizon },
      source: { in: ["PURCHASE", "SUBSCRIPTION", "ROLLOVER"] },
    },
    orderBy: { expiresAt: "asc" },
    select: { id: true, source: true, remaining: true, expiresAt: true },
  });
  const now = Date.now();
  return grants.map((g) => ({
    id: g.id,
    source: g.source,
    remaining: g.remaining,
    expiresAt: g.expiresAt as Date,
    daysLeft: Math.max(1, Math.ceil((g.expiresAt!.getTime() - now) / DAY_MS)),
  }));
}
