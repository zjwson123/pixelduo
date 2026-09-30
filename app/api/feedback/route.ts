import { z } from "zod";
import { createHash } from "crypto";
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
import { envLimit, rateLimit } from "@/lib/rate-limit";
import { prisma } from "@/lib/prisma";
import { sendFeedbackEmail } from "@/lib/mail";
import { notifyFeedback } from "@/lib/notify";
import { FEEDBACK_CATEGORY_IDS, FEEDBACK_MESSAGE_MAX, FEEDBACK_MESSAGE_MIN } from "@/lib/feedback-meta";

const schema = z.object({
  category: z.enum(FEEDBACK_CATEGORY_IDS),
  message: z.string().trim().min(FEEDBACK_MESSAGE_MIN).max(FEEDBACK_MESSAGE_MAX),
  // Used only for anonymous reports; a signed-in report always carries the
  // account's own address, so the operator replies to a verified mailbox.
  email: z.string().email().max(120).optional(),
  // Free-form attribution ("which page was this sent from"). The client already
  // reduces it to a pathname (app/feedback/page.tsx sourceHint refuses anything
  // that is not /^\/[A-Za-z0-9/_-]{0,100}$/), but the server never checked the
  // shape — and this value is interpolated into the machine-generated CONTEXT
  // BLOCK the operator triages from: lib/mail.ts prints it as `page: <value>`
  // among `ref/category/from/plan/locale` after the `---` separator, and
  // lib/notify.ts prints it into the webhook line. A newline in it therefore
  // forged extra lines — `page: "/studio\nfrom:  ceo@corp.example (user …)"`
  // makes an anonymous report read as that account's. Control characters are
  // what the block cannot survive, so that is what is refused; every legitimate
  // pathname, referrer path or query string still passes.
  page: z
    .string()
    .max(120)
    .refine((v) => !/[\u0000-\u001f\u007f]/.test(v), "page must be a single line")
    .optional(),
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

// The notification half of a submission is the expensive half: every one is a
// mail the operator pays for — out of the SMTP quota that verification and
// password-reset mail share, so a flood does not merely annoy, it can stop real
// users from receiving their links — plus a post into a group chat. The per-IP
// and per-account limits above bound ONE sender; they say nothing about the
// total, and N source addresses deliver up to 5N messages per 10 minutes, each
// with an attacker-chosen Reply-To. This ceiling is global and hourly.
//
// Exceeding it NEVER drops the message: the row is stored and the id is
// returned exactly as before, because the console is the record and a cap must
// not cost a user their report. Only the outbound notification is suppressed,
// and the suppression is announced in the log (once per window) so an operator
// whose ceiling is being hit is not left wondering why the inbox went quiet.
const NOTIFY_WINDOW_MS = 3600_000;
const DEFAULT_NOTIFY_LIMIT = 60;
let lastCapWarning = 0;

function notifyLimit(): number {
  // Read per call, not at module load: the tests raise it the same way CI does
  // for REGISTER_RATE_LIMIT, and a typo falls back to the ceiling rather than
  // removing it (see envLimit).
  return envLimit(process.env.FEEDBACK_NOTIFY_LIMIT, DEFAULT_NOTIFY_LIMIT);
}

// A retry loop — a form resubmitted after a network blip, a client that retries
// on timeout — resends byte-identical content, and one notification per attempt
// means the cheapest possible flood is an honest retry. Collapsing identical
// submissions for a few minutes costs the operator nothing (the first copy is
// already in their inbox, same body) and removes that multiplier.
const DUPLICATE_WINDOW_MS = 10 * 60_000;

// Hashed, so the Redis keys of a message queue do not become a second, longer
// lived copy of user feedback (the row in Postgres is the record).
function submissionFingerprint(email: string, category: string, message: string): string {
  return createHash("sha256").update(`${email}\u0000${category}\u0000${message}`).digest("hex");
}

// True when the outbound notification must be skipped. Never true for the
// stored row: the caller stores first and notifies second either way.
async function notificationSuppressed(email: string, category: string, message: string): Promise<boolean> {
  const repeat = await rateLimit(`feedback:dup:${submissionFingerprint(email, category, message)}`, 1, DUPLICATE_WINDOW_MS);
  if (!repeat.ok) return true;

  const limit = notifyLimit();
  const global = await rateLimit("feedback:notify-global", limit, NOTIFY_WINDOW_MS);
  if (global.ok) return false;

  const now = Date.now();
  if (now - lastCapWarning > DUPLICATE_WINDOW_MS) {
    lastCapWarning = now;
    console.warn(
      `[feedback] notification ceiling reached (${limit} per hour) — submissions are still stored and visible in the admin console, but mail/webhook notifications are suppressed for ~${global.retryAfterSec ?? 0}s`,
    );
  }
  return true;
}

export async function POST(req: Request) {
  try {
    // The budget is charged on the dimension that can be held responsible, and
    // resolved BEFORE the charge: a signed-in reporter is bounded per ACCOUNT
    // (their own submissions cannot spend a bucket their neighbours need), while
    // an anonymous one — the form's whole point — is still bounded per IP, which
    // is all there is to key on without a credential. Charging the IP bucket
    // first for everyone, as this did, meant one account's posts refused the
    // form to every co-tenant on that egress.
    //
    // The limit still precedes the body read (pass 7): nothing buffers until the
    // caller has budget left.
    const user = await optionalUser();
    if (user) {
      const userLimited = await enforceUserRateLimit(user.id, "feedback", 5, 10 * 60_000);
      if (userLimited) return fail(userLimited);
    } else {
      const limited = await enforceRateLimit(req, "feedback", 5, 10 * 60_000);
      if (limited) return limited;
    }
    const bodyRaw = await readBodyCapped(req, 8 * 1024);
    if ("tooLarge" in bodyRaw) return new Response("payload too large", { status: 413 });
    const body = schema.parse(JSON.parse(bodyRaw.raw));
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

    if (await notificationSuppressed(email, body.category, body.message)) {
      // Deliberately still a success: the message IS received, and telling the
      // sender otherwise would make them retype a report that was already kept.
      return ok({ received: true, id: row.id, at: row.createdAt });
    }

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
    // Second channel, for deployments where mail is not an option (a Feishu/
    // WeCom/DingTalk group bot is a URL, not an account with a verified domain).
    // Also best-effort: it is off unless FEEDBACK_WEBHOOK_URL is set.
    await notifyFeedback({
      ref: row.id,
      category: body.category,
      message: body.message,
      email,
      userId: user?.id ?? null,
      plan: user?.plan ?? null,
      page: body.page ?? null,
      locale: body.locale ?? null,
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
