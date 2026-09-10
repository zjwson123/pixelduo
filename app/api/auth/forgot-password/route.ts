import { z } from "zod";
import { ok, fail, enforceRateLimit, enforceUserRateLimit, readBodyCapped } from "@/lib/api";
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
    const bodyRaw = await readBodyCapped(req, 8 * 1024);
    if ("tooLarge" in bodyRaw) return new Response("payload too large", { status: 413 });
    const body = schema.parse(JSON.parse(bodyRaw.raw));
    const email = body.email.toLowerCase().trim();
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      // Per-account cap on top of the per-IP one: an attacker rotating IPs
      // must not be able to mail-bomb one address at 5×N per 15 min.
      const userLimited = await enforceUserRateLimit(user.id, "forgot-account", 5, 15 * 60_000);
      if (!userLimited) {
        const token = await createToken(email, "reset-password", user.id);
        await sendResetPasswordEmail(email, token);
      }
    }
    return ok({ sent: true });
  } catch (e) {
    if (e instanceof z.ZodError) return fail(new Error("invalid-input"));
    return fail(e);
  }
}
