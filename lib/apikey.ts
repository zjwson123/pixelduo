import { createHash, randomBytes } from "crypto";
import { prisma } from "./prisma";

// Public API keys: raw value (`pd_live_…`) is shown exactly once; only the
// SHA-256 hash and a display prefix are stored.

export function hashApiKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export async function createApiKey(
  userId: string,
  name: string,
): Promise<{ key: string; prefix: string; id: string }> {
  const raw = `pd_live_${randomBytes(24).toString("hex")}`;
  const prefix = raw.slice(0, "pd_live_".length + 4);
  const rec = await prisma.apiKey.create({
    data: { userId, name: name.trim() || "default", keyHash: hashApiKey(raw), prefix },
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
    select: { id: true, userId: true, revokedAt: true },
  });
  if (!rec || rec.revokedAt) return null;
  const user = await prisma.user.findUnique({
    where: { id: rec.userId },
    select: { emailVerified: true },
  });
  if (!user) return null;
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
