import { z } from "zod";
import {
  ApiError,
  enforceRateLimit,
  enforceUserRateLimit,
  fail,
  ok,
  readBodyCapped,
  requireUserId,
  zodMessage,
} from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { sendFeedbackEmail } from "@/lib/mail";
import { FEEDBACK_CATEGORY_IDS, FEEDBACK_MESSAGE_MAX, FEEDBACK_MESSAGE_MIN } from "@/lib/feedback-meta";

const schema = z.object({
  category: z.enum(FEEDBACK_CATEGORY_IDS),
  message: z.string().trim().min(FEEDBACK_MESSAGE_MIN).max(FEEDBACK_MESSAGE_MAX),
  // Used only for anonymous reports; a signed-in report always carries the
  // account's own address, so the operator replies to a verified mailbox.
  email: z.string().email().max(120).optional(),
  page: z.string().max(120).optional(),
  locale: z.enum(["en", "zh"]).optional(),
});

// Optional session, not requireUserId: the feedback form is deliberately
// reachable signed-out — someone who cannot sign in (a lockout, a broken
// verification mail, a registration that never completed) has no other channel
// and is exactly the person we need to hear from. Signed-in callers still go
// through the full guard so the attached account context is trustworthy.
async function optionalUser(): Promise<{ id: string; email: string; plan: string } | null> {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (e) {
    if (e instanceof ApiError) return null;
    throw e;
  }
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, plan: true },
  });
  return user;
}

export async function POST(req: Request) {
  try {
    const limited = await enforceRateLimit(req, "feedback", 5, 10 * 60_000);
    if (limited) return limited;
    const bodyRaw = await readBodyCapped(req, 8 * 1024);
    if ("tooLarge" in bodyRaw) return new Response("payload too large", { status: 413 });
    const body = schema.parse(JSON.parse(bodyRaw.raw));

    const user = await optionalUser();
    if (user) {
      // Per-account ceiling on top of the per-IP one, like every other
      // write-back route: one IP can be many accounts, and one account can
      // arrive from many IPs.
      const userLimited = await enforceUserRateLimit(user.id, "feedback", 5, 10 * 60_000);
      if (userLimited) return fail(userLimited);
    }
    const email = user?.email ?? body.email;
    if (!email) return fail(new Error("invalid-input: an email address is required when you are not signed in"));

    // Stored before it is sent: the row is the record an operator works from,
    // and the notification is best-effort (sendFeedbackEmail reports its own
    // failures). A mail outage must not discard what someone wrote.
    const row = await prisma.feedback.create({
      data: {
        userId: user?.id ?? null,
        email,
        category: body.category,
        message: body.message,
        page: body.page ?? null,
        locale: body.locale ?? null,
        plan: user?.plan ?? null,
        // Recon value for the reporter, not for us: it only makes "the button
        // did nothing" actionable. Truncated because the header is unbounded.
        userAgent: req.headers.get("user-agent")?.slice(0, 300) ?? null,
      },
      select: { id: true, createdAt: true },
    });

    await sendFeedbackEmail({
      ref: row.id,
      category: body.category,
      message: body.message,
      email,
      userId: user?.id ?? null,
      plan: user?.plan ?? null,
      page: body.page ?? null,
      locale: body.locale ?? null,
      userAgent: req.headers.get("user-agent")?.slice(0, 300) ?? null,
    });

    // The id is returned so the sender can quote it; it is their own row and
    // reveals nothing (the console resolves the full cuid, and knowing one
    // grants no access to it).
    return ok({ received: true, id: row.id, at: row.createdAt });
  } catch (e) {
    if (e instanceof z.ZodError) return fail(zodMessage(e));
    return fail(e);
  }
}

// The sender's own messages and their status, so "did anyone read this?" has an
// answer inside the product instead of only in the mailbox. Signed-in callers
// only: an anonymous report carries no identity to list it by — the reference
// shown at submit time is the way to follow one up by mail.
export async function GET() {
  try {
    const userId = await requireUserId();
    // Same reasoning as the /api/jobs pair: a read with no state change still
    // costs a query per call, and an authenticated client can loop it. The page
    // fetches once per mount.
    const limited = await enforceUserRateLimit(userId, "feedback-list", 120, 60_000);
    if (limited) return fail(limited);
    const rows = await prisma.feedback.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { id: true, category: true, message: true, status: true, createdAt: true, handledAt: true },
    });
    return ok({ feedback: rows });
  } catch (e) {
    return fail(e);
  }
}
