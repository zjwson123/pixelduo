import { requireUserId, ok, fail, enforceUserRateLimit, refuseCrossSiteRequest } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { redactJobError } from "@/lib/queue";

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

export async function POST(req: Request) {
  try {
    // Body-less route: the JSON media-type CSRF rule never ran here. See
    // refuseCrossSiteRequest (pass 45).
    refuseCrossSiteRequest(req);
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
    const [user, ledgerRows, images, jobs, orders, grantRows, apiKeys, feedback, checkins, reminders] =
      await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        // The account's own security state is part of the subject-access answer
        // (pass 61): /api/me already returns emailVerified, totpEnabled and
        // role, so withholding them from an export titled "all your data" told
        // the user less than the settings page does. `sessionVersion` stays
        // out — it is the revocation counter, not a fact about the account.
        select: {
          id: true,
          email: true,
          name: true,
          credits: true,
          plan: true,
          planRenewsAt: true,
          emailVerified: true,
          totpEnabled: true,
          role: true,
          createdAt: true,
        },
      }),
      // Explicit select, and the operator columns are dropped for the same
      // reason /api/ledger drops them (pass 43): `actorId` names the admin who
      // performed a clawback, and an unattributed admin row's `refId` is that
      // same operator id. The export returned every column, so the one view
      // pass 43 cleaned up was not the only way a normal user could read
      // another account's primary key (pass 44).
      prisma.ledgerEntry.findMany({
        where: { userId },
        orderBy: { createdAt: "asc" },
        take,
        select: {
          id: true,
          type: true,
          creditsDelta: true,
          balanceAfter: true,
          refType: true,
          refId: true,
          note: true,
          createdAt: true,
        },
      }),
      // Explicit selects for the same reason as the ledger and feedback blocks
      // above, extended to the three tables that still returned every column
      // (pass 48). `Job.worker` is minted as `worker-<hostname>-<pid>-<uuid>`,
      // so the export handed every user the deployment's hostname and process
      // ids — the operator-side identifier class pass 44 removed from the
      // ledger (`actorId`) and feedback (`handledBy`) rows. Beside it are the
      // queue's own bookkeeping: heartbeatAt / nextAttemptAt / attempts /
      // maxAttempts / taskCreatedAt (scheduler state), idempotencyKey (a
      // server-shaped key carrying the account id) and consumption (which
      // grant paid for the job), plus providerTaskId (the provider's handle for
      // something the user never sees and cannot act on). None of it is data
      // the user provided or is owed; what the workbench displays is.
      prisma.image.findMany({
        where: { userId },
        orderBy: { createdAt: "asc" },
        take,
        select: {
          id: true,
          jobId: true,
          url: true,
          model: true,
          quality: true,
          prompt: true,
          credits: true,
          createdAt: true,
        },
      }),
      prisma.job.findMany({
        where: { userId },
        orderBy: { createdAt: "asc" },
        take,
        select: {
          id: true,
          status: true,
          model: true,
          mediaType: true,
          quality: true,
          count: true,
          prompt: true,
          costCredits: true,
          images: true,
          error: true,
          durationSec: true,
          // Provenance among the user's OWN objects: which upload was edited,
          // which clip was extended, and by which of their jobs.
          refImageKey: true,
          sourceVideoKey: true,
          extendOfJobId: true,
          createdAt: true,
          startedAt: true,
          finishedAt: true,
        },
      }),
      prisma.order.findMany({
        where: { userId },
        orderBy: { createdAt: "asc" },
        take,
        select: {
          id: true,
          kind: true,
          provider: true,
          amountUsd: true,
          credits: true,
          planId: true,
          status: true,
          createdAt: true,
          paidAt: true,
          // The customer's own money facts: what was captured and what came
          // back. The provider-side payment ids and the marker arrays that
          // dedupe webhook deliveries are internal reconciliation state.
          collectedAmountUsd: true,
          refundedAmountUsd: true,
          disputedAmountUsd: true,
        },
      }),
      // The user's credit LOTS and API-key metadata were the two user-owned
      // tables the export omitted while docs/compliance/privacy.md promises
      // "可导出您的全部数据" (all your data). Grants are not reconstructible
      // from the ledger: the ledger records movements, while a grant carries
      // the lot's original amount, remaining balance and expiry — the facts
      // /api/me, /api/credits/expiring and every spend decision are made from.
      // Key metadata is what /api/account/keys shows the user, minus the hash
      // (a credential verifier, not user data — exporting it would turn a
      // read-only data export into a copy of the account's public-API
      // credentials) and the sessionVersion (internal revocation bookkeeping).
      prisma.creditGrant.findMany({
        where: { userId },
        orderBy: { createdAt: "asc" },
        take,
        select: {
          id: true,
          source: true,
          amount: true,
          remaining: true,
          expiresAt: true,
          refType: true,
          refId: true,
          createdAt: true,
        },
      }),
      prisma.apiKey.findMany({
        where: { userId },
        orderBy: { createdAt: "asc" },
        take,
        select: {
          id: true,
          name: true,
          prefix: true,
          revokedAt: true,
          lastUsedAt: true,
          createdAt: true,
        },
      }),
      // Messages the user sent while signed in. Anonymous reports carry no
      // userId and are therefore not attributable, so they cannot be included.
      // `handledBy` is the closing operator's User.id — the same cross-account
      // identifier the ledger used to leak, so it is not part of the user's
      // data export; `handledAt` still says when it was handled (pass 44).
      prisma.feedback.findMany({
        where: { userId },
        orderBy: { createdAt: "asc" },
        take,
        select: {
          id: true,
          email: true,
          category: true,
          message: true,
          status: true,
          page: true,
          locale: true,
          plan: true,
          userAgent: true,
          createdAt: true,
          handledAt: true,
        },
      }),
      // Daily check-in history (pass 60). It is user-owned data — the days the
      // account claimed and the credits each claim granted — and it was the one
      // table with a userId the export still omitted, against
      // docs/compliance/privacy.md's "可导出您的全部数据". The ledger records
      // the credit movement but not the CLAIM (or the days already claimed and
      // refused), so the history is not reconstructible from the other tables.
      prisma.checkin.findMany({
        where: { userId },
        orderBy: { date: "asc" },
        take,
        select: { id: true, date: true, credits: true, createdAt: true },
      }),
      // Credit-expiry reminder history (pass 61). CreditReminder is
      // account-linked (both erasure paths delete it explicitly) and records
      // mail the product sent about the user's own expiring lots; the ledger
      // cannot reconstruct which reminder went out for which grant. It was the
      // remaining user-owned table the export omitted.
      prisma.creditReminder.findMany({
        where: { userId },
        orderBy: { sentAt: "asc" },
        take,
        select: { id: true, grantId: true, daysBefore: true, sentAt: true },
      }),
    ]);
    const ledger = ledgerRows.map((e) => (e.refType === "admin" ? { ...e, refId: null } : e));
    // The same operator identifier rides on the grants array: adminGrantTx
    // writes the grant with refType "admin" and refId = the acting admin's
    // User.id (lib/ledger.ts). The ledger block above is sanitised; grants were
    // the third table carrying the id and the only one that still returned it
    // verbatim — the same cross-account identifier class passes 43/44 closed for
    // LedgerEntry and Feedback (pass 59).
    const grants = grantRows.map((g) => (g.refType === "admin" ? { ...g, refId: null } : g));
    // A failure recorded before pass 47's write-time mask can still carry
    // provider-echoed credentials; the export is a read path like the three job
    // views, so it applies the same read-time mask (see redactJobError).
    const safeJobs = jobs.map((j) => ({ ...j, error: redactJobError(j.error) }));
    const tables = { ledger, images, jobs: safeJobs, orders, grants, apiKeys, feedback, checkins, reminders };
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
