import { z } from "zod";
import { enforceRateLimit, errorResponse, fail, ok, parseJsonBody, readBodyCapped, zodMessage, tooLarge } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import { prisma } from "@/lib/prisma";
import { createToken } from "@/lib/tokens";
import {
  sendResetPasswordEmail,
  reserveAuthMailSend,
  authMailBudgetAvailable,
  runAfterResponse,
} from "@/lib/mail";
import { captureError } from "@/lib/observability";

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
    // The global hourly ceiling (lib/mail.ts), READ — not spent — BEFORE the
    // lookup and for EVERY address. Reading it here is what makes the refusal
    // honest and identical for a real and an invented address (the budget is
    // global, so it discloses nothing), and costs one Redis round trip on both
    // branches, so it is not a timing difference either. The matching
    // reservation happens after the response, next to the send (pass 40's
    // timing fix); spending it here for invented addresses — which pass 40
    // briefly did — let anyone drain the hour's reset budget with addresses
    // that do not exist, refusing recovery to the real users who need it. When
    // the budget is spent nothing is sent and no token is created, so a link
    // already in the user's inbox keeps working.
    if (!(await authMailBudgetAvailable("reset"))) {
      return errorResponse(
        { ok: false, error: "cannot-send-mail: the reset-mail budget for this hour is used up — try again shortly" },
        { status: 400 },
      );
    }
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      // Token creation, the budget reservation and delivery all run AFTER the
      // response. The token transaction was the remaining oracle (probed pass
      // 40: known address ~10.5-12 ms, invented ~6-10 ms over 15 pairs on a
      // quiet host — the updateMany+create transaction, before it moved off the
      // response path). Returning first makes the response depend only on work
      // both branches do: the address bucket, the budget peek and the lookup.
      //
      // Reserve inside this block, after the peek above: the two racing
      // requests for the last slot both pass the peek, and the loser simply
      // does not send — the same narrow race the peek-then-reserve pair always
      // had. It is reported rather than swallowed, because the rotation that
      // never happens is invisible otherwise and the client can request another
      // link.
      runAfterResponse(async () => {
        try {
          if (!(await reserveAuthMailSend("reset"))) {
            captureError(new Error("forgot-password lost the reset-mail reservation race after the pre-check"), {
              scope: "forgot-password-budget",
            });
            return;
          }
          const token = await createToken(email, "reset-password", user.id);
          await sendResetPasswordEmail(email, token);
        } catch (e) {
          captureError(e, { scope: "forgot-password-rotate" });
        }
      });
    }
    return ok({ sent: true });
  } catch (e) {
    if (e instanceof z.ZodError) return fail(zodMessage(e));
    return fail(e);
  }
}
