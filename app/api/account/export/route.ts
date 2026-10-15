import { requireUserId, ok, fail, enforceUserRateLimit } from "@/lib/api";
import { prisma } from "@/lib/prisma";

// Rows exported per table before the response is cut off. The bound itself is
// deliberate (an unpaged response has no ceiling), but it used to be SILENT: a
// heavy account — ledger entries run at ~2 rows per generation, so 5000 is a
// few months of normal use — received a "GDPR/PIPL data export" that quietly
// omitted everything past the cap, with no flag, no count and no way for the
// user (or an auditor reading docs/compliance/privacy.md's "可导出您的全部数据")
// to tell a complete export from a truncated one. One row past the cap is
// fetched so `truncated` is exact rather than "the last page might be short",
// and the oldest rows are kept (createdAt asc) — a client that needs the rest
// can page through the API or ask the operator.
const EXPORT_ROW_LIMIT = 5000;

export async function POST() {
  try {
    const userId = await requireUserId();
    // This is the most expensive read in the app (up to 25k rows serialized
    // into one unpaged body), so it needs a limit of its own — per ACCOUNT, and
    // the only leg: the per-IP one it carried first let one account spend the
    // bucket its neighbours' erasure/export also needed (see
    // enforceUserRateLimit).
    const limited = await enforceUserRateLimit(userId, "export", 3, 60 * 60_000);
    if (limited) return fail(limited);
    // Bounded take so a hoarded account cannot force an unbounded response —
    // one past the cap, so truncation is detectable.
    const take = EXPORT_ROW_LIMIT + 1;
    const [user, ledger, images, jobs, orders, feedback] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, email: true, name: true, credits: true, plan: true, planRenewsAt: true, createdAt: true },
      }),
      prisma.ledgerEntry.findMany({ where: { userId }, orderBy: { createdAt: "asc" }, take }),
      prisma.image.findMany({ where: { userId }, orderBy: { createdAt: "asc" }, take }),
      prisma.job.findMany({ where: { userId }, orderBy: { createdAt: "asc" }, take }),
      prisma.order.findMany({ where: { userId }, orderBy: { createdAt: "asc" }, take }),
      // Messages the user sent while signed in. Anonymous reports carry no
      // userId and are therefore not attributable, so they cannot be included.
      prisma.feedback.findMany({ where: { userId }, orderBy: { createdAt: "asc" }, take }),
    ]);
    const tables = { ledger, images, jobs, orders, feedback };
    const truncated = Object.values(tables).some((rows) => rows.length > EXPORT_ROW_LIMIT);
    const data = Object.fromEntries(
      Object.entries(tables).map(([name, rows]) => [
        name,
        rows.length > EXPORT_ROW_LIMIT ? rows.slice(0, EXPORT_ROW_LIMIT) : rows,
      ]),
    );
    return ok({
      exportedAt: new Date().toISOString(),
      truncated,
      rowLimit: EXPORT_ROW_LIMIT,
      data: { user, ...data },
    });
  } catch (e) {
    return fail(e);
  }
}
