import { createHash, randomBytes } from "crypto";
import { prisma } from "./prisma";

export type TokenPurpose = "verify-email" | "reset-password";

const TTL_MS: Record<TokenPurpose, number> = {
  "verify-email": 24 * 60 * 60 * 1000,
  "reset-password": 60 * 60 * 1000,
};

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

// Create a single-use token; previous unconsumed tokens for the same email +
// purpose are invalidated so only the latest email link works.
export async function createToken(email: string, purpose: TokenPurpose, userId?: string | null): Promise<string> {
  const raw = randomBytes(32).toString("hex");
  const now = new Date();
  await prisma.$transaction([
    prisma.verificationToken.updateMany({
      where: { email, purpose, consumedAt: null },
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

// Consume a raw token by its hash. Returns the owning email on success.
// Tokens are single-use and expire (24h verify / 1h reset).
export async function consumeToken(purpose: TokenPurpose, rawToken: string): Promise<ConsumeResult> {
  const tokenHash = sha256(rawToken);
  const now = new Date();
  const token = await prisma.verificationToken.findFirst({
    where: { purpose, tokenHash, consumedAt: null },
  });
  if (!token || token.expiresAt <= now) return { ok: false };
  const updated = await prisma.verificationToken.updateMany({
    where: { id: token.id, consumedAt: null },
    data: { consumedAt: now },
  });
  if (updated.count !== 1) return { ok: false };
  return { ok: true, email: token.email };
}

// Housekeeping: drop expired or already-consumed tokens (call from cron).
export async function purgeExpiredTokens(): Promise<number> {
  const res = await prisma.verificationToken.deleteMany({
    where: { OR: [{ expiresAt: { lt: new Date() } }, { consumedAt: { not: null } }] },
  });
  return res.count;
}
