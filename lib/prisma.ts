import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

// PostgreSQL's deadlock_detected. Prisma wraps it differently depending on
// whether the statement was raw (`$queryRaw` → P2010 with the SQLSTATE in
// `meta.code`) or one of its own (`... → PrismaClientKnownRequestError` whose
// message carries "40P01"), so match on every shape rather than one spelling.
function isDeadlock(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const err = e as { code?: unknown; message?: unknown; meta?: { code?: unknown; message?: unknown } };
  const text = [err.message, err.meta?.message]
    .filter((s): s is string => typeof s === "string")
    .join(" ");
  return (
    err.code === "40P01" ||
    err.meta?.code === "40P01" ||
    text.includes("40P01") ||
    text.toLowerCase().includes("deadlock detected")
  );
}

// Retry a transaction that PostgreSQL chose as a deadlock victim.
//
// Deliberately narrow: only 40P01 is retried, so a business error (or any other
// SQLSTATE) still surfaces on the first attempt. Callers must pass a closure
// that is idempotent — a rolled-back transaction leaves nothing behind, so a
// re-run re-reads the same state and reaches the same decision, which is true of
// every use here (read ⇒ decide ⇒ delete/decrement).
//
// The erasure routes are the reason this exists. A total lock order is only
// total over the writers that exist today (four of them take the Order or Job
// row before the grants), and the cost of being wrong about the next one is a
// 500 on the one route whose whole contract is that the customer can retry.
export async function withDeadlockRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= attempts || !isDeadlock(e)) throw e;
    }
  }
}
