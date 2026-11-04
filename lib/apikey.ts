import { createHash, randomBytes } from "crypto";
import { prisma } from "./prisma";
import type { Prisma } from "@prisma/client";

// Public API keys: raw value (`pd_live_…`) is shown exactly once; only the
// SHA-256 hash and a display prefix are stored.

export function hashApiKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export async function createApiKey(
  userId: string,
  name: string,
  // The account's sessionVersion at the moment of minting — stamped on the row
  // so the key is invalidated atomically by the same bump that revokes sessions
  // (see the ApiKey.sessionVersion note in prisma/schema.prisma).
  sessionVersion: number,
  // Optional transaction client so the caller can mint the key under the same
  // advisory lock that enforces the per-account active-key cap.
  tx: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<{ key: string; prefix: string; id: string }> {
  const raw = `pd_live_${randomBytes(24).toString("hex")}`;
  const prefix = raw.slice(0, "pd_live_".length + 4);
  const rec = await tx.apiKey.create({
    data: { userId, name: name.trim() || "default", keyHash: hashApiKey(raw), prefix, sessionVersion },
  });
  return { key: raw, prefix, id: rec.id };
}

export interface ApiKeyAuth {
  keyId: string;
  userId: string;
  emailVerified: Date | null;
}

// Resolve `Authorization: Bearer pd_live_…` to an account. Returns null for
// missing / unknown / revoked keys (generic 401, no enumeration).
export async function authenticateApiKey(req: Request): Promise<ApiKeyAuth | null> {
  const auth = req.headers.get("authorization") ?? "";
  const raw = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!raw) return null;
  const rec = await prisma.apiKey.findUnique({
    where: { keyHash: hashApiKey(raw) },
    select: { id: true, userId: true, revokedAt: true, sessionVersion: true },
  });
  if (!rec || rec.revokedAt) return null;
  const user = await prisma.user.findUnique({
    where: { id: rec.userId },
    select: { emailVerified: true, sessionVersion: true },
  });
  if (!user) return null;
  // The atomic half of key revocation: a bump of User.sessionVersion (password
  // reset, revoke-sessions, 2FA enable/disable — each of which also flips
  // `revokedAt`) invalidates this key even if the key's INSERT committed after
  // that flip, which no read-then-write revocation can order against.
  if (rec.sessionVersion !== user.sessionVersion) return null;
  prisma.apiKey
    .update({ where: { id: rec.id }, data: { lastUsedAt: new Date() } })
    .catch(() => undefined);
  return { keyId: rec.id, userId: rec.userId, emailVerified: user.emailVerified };
}

export async function revokeApiKey(userId: string, keyId: string): Promise<boolean> {
  const res = await prisma.apiKey.updateMany({
    where: { id: keyId, userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return res.count === 1;
}

// How many REVOKED keys an account keeps for display. Revocation never deleted
// the row, so an account could mint (5/min) and revoke (20/min) forever: one
// day of a script left ~7,200 rows, `GET /api/account/keys` returned every one
// of them on each call (no take/cursor), and the table grew permanently for
// every tenant because nothing else prunes. Only the newest few revoked keys
// have any display value — the rest are history nobody can act on. Active keys
// are never touched: their own cap (MAX_ACTIVE_KEYS) is enforced separately.
const MAX_REVOKED_KEYS_RETAINED = 50;

// Rows removed per call. A pre-fix account can carry a tail this function is
// the only cure for, and both failure modes have to stay bounded: an unbounded
// DELETE inside the mint transaction can exceed Prisma's 5s interactive budget
// (P2028 would roll the mint back and the next attempt would retry the same
// DELETE forever), and binding one parameter per stale row hits Postgres's
// 32,767-parameter ceiling at ~2 days of scripted revocation (pass 18). One
// bounded batch per mint converges in a few mints; callers prune best-effort,
// outside the transaction, so neither failure can block a key mint.
const MAX_PRUNE_BATCH = 500;

export async function pruneRevokedApiKeys(
  userId: string,
  tx: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<number> {
  const keep = await tx.apiKey.findMany({
    where: { userId, revokedAt: { not: null } },
    orderBy: { createdAt: "desc" },
    take: MAX_REVOKED_KEYS_RETAINED,
    select: { id: true },
  });
  // Fewer than the retained window means nothing to retire.
  if (keep.length < MAX_REVOKED_KEYS_RETAINED) return 0;
  // Oldest first, so the retention window is what survives. Selecting ids now
  // (rather than deleting by predicate) also keeps a concurrently revoked key
  // out of the batch: it was active at query time and is therefore not in this
  // list, so its owner still sees the revocation they just performed.
  const stale = await tx.apiKey.findMany({
    where: { userId, revokedAt: { not: null }, id: { notIn: keep.map((k) => k.id) } },
    orderBy: { createdAt: "asc" },
    take: MAX_PRUNE_BATCH,
    select: { id: true },
  });
  if (stale.length === 0) return 0;
  const res = await tx.apiKey.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } });
  return res.count;
}
