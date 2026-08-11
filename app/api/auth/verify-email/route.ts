import { z } from "zod";
import { ok, fail, enforceRateLimit } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { signupBonus } from "@/lib/ledger";
import { consumeToken } from "@/lib/tokens";

const schema = z.object({ token: z.string().min(20).max(200) });

export async function POST(req: Request) {
  try {
    const limited = await enforceRateLimit(req, "verify", 10, 60_000);
    if (limited) return limited;
    const body = schema.parse(await req.json());
    const result = await consumeToken("verify-email", body.token);
    if (!result.ok || !result.email) return fail(new Error("invalid-token"));

    const user = await prisma.user.findUnique({ where: { email: result.email } });
    if (!user) return fail(new Error("invalid-token"));
    // updateMany guards against double-verification granting the bonus twice.
    const updated = await prisma.user.updateMany({
      where: { id: user.id, emailVerified: null },
      data: { emailVerified: new Date() },
    });
    if (updated.count === 1) {
      await signupBonus(user.id);
      return ok({ verified: true, credits: 30 });
    }
    return ok({ verified: true, alreadyVerified: true });
  } catch (e) {
    if (e instanceof z.ZodError) return fail(new Error("invalid-token"));
    return fail(e);
  }
}
