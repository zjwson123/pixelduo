import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { signupBonus } from "@/lib/ledger";
import { createToken } from "@/lib/tokens";
import { sendVerificationEmail } from "@/lib/mail";
import { ok, fail, enforceRateLimit } from "@/lib/api";

const schema = z.object({
  email: z.string().email().max(120),
  password: z.string().min(8).max(100),
  name: z.string().max(60).optional(),
});

export async function POST(req: Request) {
  try {
    const limited = await enforceRateLimit(req, "register", 10, 3_600_000);
    if (limited) return limited;
    const body = schema.parse(await req.json());
    const email = body.email.toLowerCase().trim();
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) return fail(new Error("email-already-registered"));
    const passwordHash = await bcrypt.hash(body.password, 10);
    const user = await prisma.user.create({
      data: { email, passwordHash, name: body.name?.trim() || email.split("@")[0] },
    });
    // Anti-abuse: the 30-credit signup bonus is granted only after the email
    // is verified. Tests/CI can auto-verify via EMAIL_VERIFY_AUTO=1.
    if (process.env.EMAIL_VERIFY_AUTO === "1") {
      await prisma.user.update({ where: { id: user.id }, data: { emailVerified: new Date() } });
      await signupBonus(user.id);
      return ok({ userId: user.id, credits: 30, pendingVerification: false });
    }
    const token = await createToken(email, "verify-email", user.id);
    await sendVerificationEmail(email, token);
    return ok({ userId: user.id, credits: 0, pendingVerification: true });
  } catch (e) {
    if (e instanceof z.ZodError) return fail(new Error("invalid-input"));
    return fail(e);
  }
}
