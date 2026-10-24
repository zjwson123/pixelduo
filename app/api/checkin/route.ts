import { requireVerifiedUser, ok, fail, enforceUserRateLimit, refuseCrossSiteRequest } from "@/lib/api";
import { dailyCheckin } from "@/lib/ledger";
import { spendableBalance } from "@/lib/credits";

export async function POST(req: Request) {
  try {
    // No body, so readBodyCapped's media-type CSRF rule does not apply here;
    // see refuseCrossSiteRequest (pass 45).
    refuseCrossSiteRequest(req);
    const userId = await requireVerifiedUser();
    // Idempotent per day, so this is not a correctness guard — it keeps a
    // scripted loop from hammering the DB. Keyed on the ACCOUNT and nothing
    // else: the per-IP leg it used to carry first meant one verified account
    // could hold `checkin:<egress>` full with junk requests and refuse the
    // daily check-in to every neighbour behind the same NAT (see
    // enforceUserRateLimit).
    const limited = await enforceUserRateLimit(userId, "checkin", 10, 60_000);
    if (limited) return fail(limited);
    const result = await dailyCheckin(userId);
    // The SPENDABLE balance, not User.credits (pass 38 — see spendableBalance
    // in lib/credits.ts). This route reported the raw column, so an account
    // with expired-but-unswept grants was told it held 142 credits while
    // /api/me said 42 and the very next generate call refused everything above
    // 42 (probed with a one-minute-old expired grant). Read after the check-in
    // commits, so the fresh +2 is included.
    const held = await spendableBalance(userId);
    return ok({ ...result, balance: held.spendable });
  } catch (e) {
    return fail(e);
  }
}
