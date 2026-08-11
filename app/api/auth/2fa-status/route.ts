import { sessionUser, ok, fail } from "@/lib/api";

// Tells the login page whether the freshly created session still needs the
// second factor (partial 2FA session) before granting access.
export async function GET() {
  try {
    const su = await sessionUser();
    return ok({ needs2fa: su.totpPending });
  } catch (e) {
    return fail(e);
  }
}
