import { z } from "zod";
import {
  zodMessage,
  ok,
  fail,
  errorResponse,
  enforceRateLimit,
  readBodyCapped,
} from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import { prisma } from "@/lib/prisma";
import { createToken } from "@/lib/tokens";
import { sendResetPasswordEmail, reserveAuthMailSend } from "@/lib/mail";

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
    if ("tooLarge" in bodyRaw) return new Response("payload too large", { status: 413 });
    const body = schema.parse(JSON.parse(bodyRaw.raw));
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
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      // The global hourly ceiling (lib/mail.ts) before the rotation it would
      // otherwise perform: when the budget is spent the mail is skipped AND no
      // token is created, so a link already in the user's inbox keeps working
      // instead of being invalidated by a mail that never leaves. The response
      // stays uniform (the check is made after the lookup, so it discloses
      // nothing about the address).
      if (await reserveAuthMailSend("reset")) {
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
