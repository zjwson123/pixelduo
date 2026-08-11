import bcrypt from "bcryptjs";
import { z } from "zod";
import { ok, fail, enforceRateLimit } from "@/lib/api";
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
    const body = schema.parse(await req.json());
    const result = await consumeToken("reset-password", body.token);
    if (!result.ok || !result.email) return fail(new Error("invalid-token"));
    const user = await prisma.user.findUnique({ where: { email: result.email } });
    if (!user) return fail(new Error("invalid-token"));
    const passwordHash = await bcrypt.hash(body.password, 10);
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });
    return ok({ reset: true });
  } catch (e) {
    if (e instanceof z.ZodError) return fail(new Error("invalid-input"));
    return fail(e);
  }
}
