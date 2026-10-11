import { z } from "zod";
import { enforceRateLimit, errorResponse, fail, ok, parseJsonBody, readBodyCapped, zodMessage, tooLarge } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import { prisma } from "@/lib/prisma";
import { createToken } from "@/lib/tokens";
import { sendResetPasswordEmail, reserveAuthMailSend, authMailBudgetAvailable } from "@/lib/mail";

const schema = z.object({ email: z.string().email().max(120) });

// Per-address budget on the mail stream. Deliberately spent for EVERY address,
// existing or not (the key is the submitted address, not a userId), because the
// refusal below has to be the same for both: keying it on a resolved user made
// the sixth request from a sixth IP answer 429 for a real address and 200 for a
// made-up one, which is an existence oracle — and the bucket was spendable by
// anyone, so a third party could hold it full and the owner's own request became
// a silent no-op (`ok({sent:true})` with no token and no mail), i.e. the account
// owner could be denied password recovery while being told to check their inbox.
const ADDRESS_LIMIT = 5;
const ADDRESS_WINDOW_MS = 15 * 60_000;

// Always returns ok for the address-lookup path to avoid account enumeration;
// only sends when the email exists.
export async function POST(req: Request) {
  try {
    const limited = await enforceRateLimit(req, "forgot", 5, 15 * 60_000);
    if (limited) return limited;
    const bodyRaw = await readBodyCapped(req, 8 * 1024);
    if ("tooLarge" in bodyRaw) return tooLarge();
    const body = schema.parse(parseJsonBody(bodyRaw.raw));
    const email = body.email.toLowerCase().trim();
    // Refused for a real address and a made-up one alike (see ADDRESS_LIMIT),
    // and reported honestly rather than swallowed: the caller learns to come
    // back in a few minutes instead of waiting for a mail that was never sent.
    const address = await rateLimit(`u:forgot-address:${email}`, ADDRESS_LIMIT, ADDRESS_WINDOW_MS);
    if (!address.ok) {
      return errorResponse(
        { ok: false, error: "rate-limited" },
        { status: 429, headers: { "Retry-After": String(address.retryAfterSec) } },
      );
    }
    // The global hourly ceiling (lib/mail.ts), read BEFORE the lookup and
    // without spending anything: when the budget is spent the mail is skipped
    // AND no token is created, so a link already in the user's inbox keeps
    // working instead of being invalidated by a mail that never leaves.
    //
    // Read here rather than inside `if (user)` because this branch is the one
    // place the refusal can be honest: the ceiling is global, so the answer is
    // identical for a real and an invented address and discloses nothing.
    // Deciding it after the lookup made a real address answer 400 while an
    // invented one answered 200 — an existence oracle — which is what forced
    // the previous version to hide it behind a uniform `ok({sent:true})` and
    // leave the caller waiting for a mail that was never sent. Reading it first
    // also means a refused request costs no database round trip. (The
    // per-address branch above cannot be reported per-caller for the same
    // reason; that is why it is charged on the submitted address only.)
    if (!(await authMailBudgetAvailable("reset"))) {
      return errorResponse(
        { ok: false, error: "cannot-send-mail: the reset-mail budget for this hour is used up — try again shortly" },
        { status: 400 },
      );
    }
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      if (!(await reserveAuthMailSend("reset"))) {
        // The last slot went between the read above and this reserve (a
        // concurrent request for another address took it). Answer the same
        // refusal — the budget is global, so this is not address-dependent —
        // rather than the `ok({sent:true})` for a mail that was never sent,
        // which is the whole reason this branch exists.
        return errorResponse(
          { ok: false, error: "cannot-send-mail: the reset-mail budget for this hour is used up — try again shortly" },
          { status: 400 },
        );
      }
      {
        const token = await createToken(email, "reset-password", user.id);
        // Deliberately NOT awaited. A uniform `{sent:true}` body closed the
        // content channel, but the unknown-address path answers in ~1ms while
        // this one created a token AND completed a full SMTP exchange (fresh
        // TCP+TLS+auth+DATA per message — the URL uses no pool) in hundreds of
        // ms, so one request per address read account existence off the clock.
        // The login path installs a DUMMY_HASH for exactly this reason; here the
        // cheap equivalent is to return without waiting for delivery. Failures
        // are still reported: sendSafely captures them before rethrowing, and
        // the user can simply request another link.
        void sendResetPasswordEmail(email, token).catch(() => undefined);
      }
    }
    return ok({ sent: true });
  } catch (e) {
    if (e instanceof z.ZodError) return fail(zodMessage(e));
    return fail(e);
  }
}
