import { z } from "zod";
import { ok, fail, enforceRateLimit } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { createToken } from "@/lib/tokens";
import { sendResetPasswordEmail } from "@/lib/mail";

const schema = z.object({ email: z.string().email().max(120) });

// Always returns ok to avoid account enumeration; only sends when the email
// exists.
export async function POST(req: Request) {
  try {
    const limited = await enforceRateLimit(req, "forgot", 5, 15 * 60_000);
    if (limited) return limited;
    const body = schema.parse(await req.json());
    const email = body.email.toLowerCase().trim();
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      const token = await createToken(email, "reset-password", user.id);
      await sendResetPasswordEmail(email, token);
    }
    return ok({ sent: true });
  } catch (e) {
    if (e instanceof z.ZodError) return fail(new Error("invalid-input"));
    return fail(e);
  }
}
