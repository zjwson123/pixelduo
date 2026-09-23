import { requirePartialSession, ok, fail, enforceUserRateLimit } from "@/lib/api";

// Tells the login page whether the freshly created session still needs the
// second factor (partial 2FA session) before granting access.
export async function GET() {
  try {
    // Checked against the DB sessionVersion like every other authenticated
    // route: a revoked/expired partial session must not keep probing.
    const su = await requirePartialSession();
    // Per-account, on the DB-read path the sessionVersion check above runs on.
    const limited = await enforceUserRateLimit(su.id, "2fa-status", 120, 60_000);
    if (limited) return fail(limited);
    return ok({ needs2fa: su.totpPending });
  } catch (e) {
    return fail(e);
  }
}
