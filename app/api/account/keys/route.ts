import { z } from "zod";
import { requireVerifiedUser, ok, fail, enforceRateLimit } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { createApiKey } from "@/lib/apikey";
import { verifyTotp, useBackupCode } from "@/lib/twofa";
import bcrypt from "bcryptjs";

const schema = z.object({
  name: z.string().min(1).max(60).optional(),
  password: z.string().min(1).max(100),
  token: z.string().min(6).max(20).optional(),
  backupCode: z.string().min(8).max(40).optional(),
});

// List the current user's API keys (display info only — raw key is never
// retrievable after creation).
export async function GET() {
  try {
    const userId = await requireVerifiedUser();
    const keys = await prisma.apiKey.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      select: { id: true, name: true, prefix: true, revokedAt: true, lastUsedAt: true, createdAt: true },
    });
    return ok({ keys });
  } catch (e) {
    return fail(e);
  }
}

const MAX_ACTIVE_KEYS = 10;

// Minting a key needs re-authentication (same bar as account deletion): a
// stolen session cookie alone must not be able to mint a pd_live_ key that
// outlives the session and never consults sessionVersion.
export async function POST(req: Request) {
  try {
    const userId = await requireVerifiedUser();
    const limited = await enforceRateLimit(req, "apikey-create", 5, 60_000);
    if (limited) return limited;
    const body = schema.parse(await req.json());
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { passwordHash: true, totpSecret: true, totpEnabled: true },
    });
    if (!(await bcrypt.compare(body.password, user.passwordHash))) return fail(new Error("invalid-password"));
    if (user.totpEnabled && user.totpSecret) {
      const ok2 = body.token
        ? verifyTotp(user.totpSecret, body.token)
        : await useBackupCode(userId, body.backupCode!);
      if (!ok2) return fail(new Error("invalid-code"));
    }
    // Cap active keys: unbounded creation bloats the table and each key adds
    // its own per-key v1 rate budget.
    const active = await prisma.apiKey.count({ where: { userId, revokedAt: null } });
    if (active >= MAX_ACTIVE_KEYS) return fail(new Error("too-many-keys: revoke one before creating another"));
    const key = await createApiKey(userId, body.name ?? "default");
    return ok({ ...key, note: "copy now — the full key is shown only once" });
  } catch (e) {
    if (e instanceof z.ZodError) return fail(new Error("invalid-input"));
    return fail(e);
  }
}
