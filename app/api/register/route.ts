import bcrypt from "bcryptjs";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { signupBonus } from "@/lib/ledger";
import { createToken } from "@/lib/tokens";
import { sendVerificationEmail, reserveAuthMailSend } from "@/lib/mail";
import {
  enforceRateLimit,
  fail,
  ok,
  parseJsonBody,
  passwordWithinBcrypt,
  readBodyCapped,
  zodMessage,
  tooLarge,
  MAX_PASSWORD_BYTES,
} from "@/lib/api";
import { envLimit } from "@/lib/rate-limit";

const schema = z.object({
  email: z.string().email().max(120),
  // .max(100) counts UTF-16 units, but bcrypt stores only the first 72 BYTES —
  // everything past that was silently discarded, so the account's real password
  // was a prefix of the one the user chose (see MAX_PASSWORD_BYTES in
  // lib/api.ts). Refuse at the real boundary instead.
  password: z
    .string()
    .min(8)
    .max(100)
    .refine(passwordWithinBcrypt, {
      message: `must be at most ${MAX_PASSWORD_BYTES} bytes (UTF-8) — bcrypt stores only the first ${MAX_PASSWORD_BYTES} bytes`,
    }),
  name: z.string().max(60).optional(),
});

export async function POST(req: Request) {
  try {
    // Default 10 registrations/hour/IP; tests/CI raise it via env so repeated
    // suite runs don't exhaust the counter (per-account abuse is contained by
    // email verification + signup bonus after verification).
    const registerLimit = envLimit(process.env.REGISTER_RATE_LIMIT, 10);
    const limited = await enforceRateLimit(req, "register", registerLimit, 3_600_000);
    if (limited) return limited;
    const bodyRaw = await readBodyCapped(req, 8 * 1024);
    if ("tooLarge" in bodyRaw) return tooLarge();
    const body = schema.parse(parseJsonBody(bodyRaw.raw));
    const email = body.email.toLowerCase().trim();
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) return fail(new Error("email-already-registered"));
    const passwordHash = await bcrypt.hash(body.password, 10);
    let user;
    try {
      user = await prisma.user.create({
        data: { email, passwordHash, name: body.name?.trim() || email.split("@")[0] },
      });
    } catch (e) {
      // Two concurrent registrations of the same address both pass the lookup
      // above, and the loser hits the unique index. That is the same conflict the
      // sequential path answers with a 409 — an unauthenticated caller could
      // otherwise mint unlimited 500s (and a captured incident each) by racing
      // its own requests, which is the shape the payment webhook's P2002 handler
      // already closes.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        return fail(new Error("email-already-registered"));
      }
      throw e;
    }
    // Anti-abuse: the 30-credit signup bonus is granted only after the email
    // is verified. Tests/CI can auto-verify via EMAIL_VERIFY_AUTO=1.
    if (process.env.EMAIL_VERIFY_AUTO === "1") {
      // One transaction (pass 39): a crash between the flip and the bonus left
      // a verified account that could never win the flip again, so the 30
      // credits were lost with no retry path.
      await prisma.$transaction(async (tx) => {
        await tx.user.update({ where: { id: user.id }, data: { emailVerified: new Date() } });
        await signupBonus(user.id, tx);
      });
      return ok({ userId: user.id, credits: 30, pendingVerification: false });
    }
    const token = await createToken(email, "verify-email", user.id);
    // The verification stream's hourly ceiling (lib/mail.ts): under a signup
    // flood the account and its token are still created — the row is the
    // record, and the user can ask for the link again — but the send is skipped
    // rather than spent from the SMTP quota that resets and receipts share.
    // Separate from the reset stream on purpose: a flood here must not be able
    // to stop password recovery.
    //
    // When the budget is gone the caller is TOLD, with the same
    // `cannot-send-mail:` refusal the resend route gives — the alternative was
    // `pendingVerification: true` with no mail behind it, i.e. an instruction to
    // check an inbox that will stay empty.
    if (!(await reserveAuthMailSend("verify"))) {
      return fail(new Error("cannot-send-mail: email budget for this hour is used up — try again shortly"));
    }
    await sendVerificationEmail(email, token);
    return ok({ userId: user.id, credits: 0, pendingVerification: true });
  } catch (e) {
    if (e instanceof z.ZodError) return fail(zodMessage(e));
    return fail(e);
  }
}
