import { requireVerifiedUser, ok, fail, enforceUserRateLimit, refuseNul, refuseCrossSiteRequest } from "@/lib/api";
import { revokeApiKey } from "@/lib/apikey";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    // Body-less route: without this, a same-site page could revoke the
    // owner's keys. See refuseCrossSiteRequest (pass 45).
    refuseCrossSiteRequest(req);
    // %00 → U+0000 → SQLSTATE 22021 → masked 500 + captured incident; the
    // sibling leg of pass 25's body/query NUL guards.
    refuseNul(id);
    const userId = await requireVerifiedUser();
    // Ownership-scoped (a foreign id matches nothing), but bound the loop.
    const userLimited = await enforceUserRateLimit(userId, "apikey-revoke", 20, 60_000);
    if (userLimited) return fail(userLimited);
    const revoked = await revokeApiKey(userId, id);
    if (!revoked) return fail(new Error("invalid-key"));
    return ok({ revoked: true });
  } catch (e) {
    return fail(e);
  }
}
