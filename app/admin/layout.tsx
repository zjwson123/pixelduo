import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/admin";
import { ApiError } from "@/lib/api";

// requireAdmin, not a bare getServerSession: it re-reads User.sessionVersion
// (a session revoked by reset-password / revoke-sessions must stop rendering the
// console immediately) and re-reads `role` from the DB, so a demoted admin loses
// the shell on the next request rather than whenever the JWT expires.
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  let destination: string | null = null;
  try {
    await requireAdmin();
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    if (e.message === "admin-required") destination = "/studio";
    else if (e.message === "2fa-required") destination = "/login?2fa=1";
    else destination = "/login";
  }
  if (destination) redirect(destination);
  return <>{children}</>;
}
