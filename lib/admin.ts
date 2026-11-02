import { requireUserId, ApiError } from "./api";
import { prisma } from "./prisma";
// Re-exported so every existing importer keeps its import site; the definitions
// live in a leaf module so scripts/promote-admin.ts can share the same lock
// without loading the request stack.
export { ADMIN_GUARD_LOCK, ADMIN_TX_OPTIONS, assertAnotherAdminRemains } from "./admin-guard";

// Operator gate for admin-only endpoints.
export async function requireAdmin(): Promise<string> {
  const userId = await requireUserId();
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
  if (user?.role !== "admin") throw new ApiError(403, "admin-required");
  return userId;
}

