import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession(authOptions);
  const su = session?.user as { id?: string; totpPending?: boolean } | undefined;
  if (!su?.id) redirect("/login");
  if (su.totpPending) redirect("/login?2fa=1");
  const user = await prisma.user.findUnique({ where: { id: su.id }, select: { role: true } });
  if (user?.role !== "admin") redirect("/studio");
  return <>{children}</>;
}
