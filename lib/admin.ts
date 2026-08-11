import { requireUserId, ApiError } from "./api";
import { prisma } from "./prisma";

// Operator gate for admin-only endpoints.
export async function requireAdmin(): Promise<string> {
  const userId = await requireUserId();
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
  if (user?.role !== "admin") throw new ApiError(403, "admin-required");
  return userId;
}
