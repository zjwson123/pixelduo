import { redirect } from "next/navigation";
import { requireUserId, ApiError } from "@/lib/api";

// requireUserId, not a bare getServerSession: it re-reads User.sessionVersion,
// so a session revoked by reset-password / revoke-sessions / a 2FA change stops
// rendering the authenticated shell instead of staying logged-in-looking until
// the 30-day JWT expires. Every data API behind this shell already rejects such
// a session (no leak either way), but a "sign out all devices" that visibly
// does nothing in the browser undermines the exact remediation we tell a
// compromised user to perform. redirect() signals by throwing, so it must stay
// OUTSIDE the try/catch that inspects the ApiError.
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  let destination: string | null = null;
  try {
    await requireUserId();
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    destination = e.status === 403 ? "/login?2fa=1" : "/login";
  }
  if (destination) redirect(destination);
  return <>{children}</>;
}
