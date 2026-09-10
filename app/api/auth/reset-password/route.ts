import bcrypt from "bcryptjs";
import { z } from "zod";
import { ok, fail, enforceRateLimit, readBodyCapped } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { consumeToken } from "@/lib/tokens";

const schema = z.object({
  token: z.string().min(20).max(200),
  password: z.string().min(8).max(100),
});

export async function POST(req: Request) {
  try {
    const limited = await enforceRateLimit(req, "reset", 10, 60_000);
    if (limited) return limited;
    const bodyRaw = await readBodyCapped(req, 8 * 1024);
    if ("tooLarge" in bodyRaw) return new Response("payload too large", { status: 413 });
    const body = schema.parse(JSON.parse(bodyRaw.raw));
    const result = await consumeToken("reset-password", body.token);
    if (!result.ok || !result.email) return fail(new Error("invalid-token"));
    const user = await prisma.user.findUnique({ where: { email: result.email } });
    if (!user) return fail(new Error("invalid-token"));
    const passwordHash = await bcrypt.hash(body.password, 10);
    // Bump sessionVersion so all previously issued JWTs are rejected, and
    // revoke API keys too: a password reset means the account may be
    // compromised, and any key minted by an attacker keeps working otherwise
    // (authenticateApiKey never consults sessionVersion).
    await prisma.$transaction([
      prisma.user.update({
        where: { id: user.id },
        data: { passwordHash, sessionVersion: { increment: 1 } },
      }),
      prisma.apiKey.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
    return ok({ reset: true });
  } catch (e) {
    if (e instanceof z.ZodError) return fail(new Error("invalid-input"));
    return fail(e);
  }
}
