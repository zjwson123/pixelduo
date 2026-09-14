import { requirePartialSession, ok, fail } from "@/lib/api";

// Tells the login page whether the freshly created session still needs the
// second factor (partial 2FA session) before granting access.
export async function GET() {
  try {
    // Checked against the DB sessionVersion like every other authenticated
    // route: a revoked/expired partial session must not keep probing.
    const su = await requirePartialSession();
    return ok({ needs2fa: su.totpPending });
  } catch (e) {
    return fail(e);
  }
}
