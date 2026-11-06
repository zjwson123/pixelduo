import { createHash, randomBytes } from "crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { dbNow } from "./ledger";

export type TokenPurpose = "verify-email" | "reset-password";

const TTL_MS: Record<TokenPurpose, number> = {
  "verify-email": 24 * 60 * 60 * 1000,
  "reset-password": 60 * 60 * 1000,
};

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

// A link younger than this survives a rotation, so asking for a new one does
// not invalidate the mail the user is reading right now.
//
// Invalidation-on-issue exists so a stale link (an old mail still sitting in a
// mailbox) cannot be used after the user asked for a fresh one. That is worth
// keeping across hours; inside minutes it is a way to refuse recovery to
// everyone: /forgot-password needs no session and answers {sent:true} for any
// address, so whoever knows an address could re-request every ~3 minutes
// (5/15min per account) and invalidate each reset link before its owner could
// click it — killing recovery for exactly the account whose password someone is
// grinding. Both links land in the same mailbox, so a grace window widens
// nothing: whoever can read one can read the other.
const ROTATION_GRACE_MS = 30 * 60 * 1000;

// Create a single-use token; previous unconsumed tokens for the same email +
// purpose are invalidated so only the latest email link works.
export async function createToken(email: string, purpose: TokenPurpose, userId?: string | null): Promise<string> {
  const raw = randomBytes(32).toString("hex");
  // Both sides of these comparisons have to be on ONE clock. `createdAt` is
  // stamped by the column default, i.e. the DATABASE's now(), while the cutoff
  // and the new expiry used to be built from the app's `new Date()`. With the
  // app ahead of the database by more than the grace window, a link the owner
  // had just been mailed counted as stale and the next /forgot-password request
  // — which needs no mailbox — consumed it before they could click (pass 54);
  // the same skew shortened or lengthened every token's TTL. dbNow is the
  // database's clock, the one that stamped the row and will judge it later.
  const now = await dbNow(prisma);
  await prisma.$transaction([
    prisma.verificationToken.updateMany({
      where: {
        email,
        purpose,
        consumedAt: null,
        createdAt: { lt: new Date(now.getTime() - ROTATION_GRACE_MS) },
      },
      data: { consumedAt: now },
    }),
    prisma.verificationToken.create({
      data: {
        email,
        userId,
        purpose,
        tokenHash: sha256(raw),
        expiresAt: new Date(now.getTime() + TTL_MS[purpose]),
      },
    }),
  ]);
  return raw;
}

export interface ConsumeResult {
  ok: boolean;
  email?: string;
}

// Look a token up WITHOUT consuming it. The verification route has to check
// the registrant's password before it spends the single use, so it needs the
// owning email first; consumeToken still owns the atomic single-use CAS, and
// the route therefore re-checks it after the password compare.
export async function previewToken(purpose: TokenPurpose, rawToken: string): Promise<ConsumeResult> {
  const token = await prisma.verificationToken.findFirst({
    where: { purpose, tokenHash: sha256(rawToken), consumedAt: null },
  });
  if (!token || token.expiresAt <= (await dbNow(prisma))) return { ok: false };
  return { ok: true, email: token.email };
}

// Consume a raw token by its hash. Returns the owning email on success.
// Tokens are single-use and expire (24h verify / 1h reset).
//
// The optional client lets a caller spend the token in the SAME transaction as
// the state change it authorizes (pass 39: verify-email's consume → mark
// verified → signup bonus used to be two transactions, so a failure in the
// second burned the link and left the account verified-without-bonus or, worse,
// unverified with no way to retry).
export async function consumeToken(
  purpose: TokenPurpose,
  rawToken: string,
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<ConsumeResult> {
  const tokenHash = sha256(rawToken);
  const token = await client.verificationToken.findFirst({
    where: { purpose, tokenHash, consumedAt: null },
  });
  // Same one-clock rule as createToken/previewToken.
  if (!token) return { ok: false };
  const now = await dbNow(client);
  if (token.expiresAt <= now) return { ok: false };
  const updated = await client.verificationToken.updateMany({
    where: { id: token.id, consumedAt: null },
    data: { consumedAt: now },
  });
  if (updated.count !== 1) return { ok: false };
  return { ok: true, email: token.email };
}

// Housekeeping: drop expired or already-consumed tokens (call from cron).
export async function purgeExpiredTokens(): Promise<number> {
  // The cutoff is the database's clock, like the validity checks above: an app
  // clock ahead of the database would otherwise purge links the consuming
  // routes still accept.
  const now = await dbNow(prisma);
  const res = await prisma.verificationToken.deleteMany({
    where: { OR: [{ expiresAt: { lt: now } }, { consumedAt: { not: null } }] },
  });
  return res.count;
}
