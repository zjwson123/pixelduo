import { redirect } from "next/navigation";
import { requireUserId, ApiError } from "@/lib/api";

// requireUserId, not a bare getServerSession — same revocation reasoning as
// app/studio/layout.tsx: this shell exposes the API-key and account-deletion
// UI, and a session revoked by reset-password must not keep rendering it.
export default async function AccountLayout({ children }: { children: React.ReactNode }) {
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
