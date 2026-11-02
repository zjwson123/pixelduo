import type { Prisma } from "@prisma/client";

// The last-admin invariants live in a leaf module so the operator script can
// take the same lock without importing lib/api (next-auth, next/server). A
// script that duplicated the constant would silently stop serializing with the
// HTTP routes the day one side changed; a script that imported lib/admin would
// drag the whole request stack into a CLI.

// Serializes every mutation that could remove the last admin. A fixed
// transaction-scoped advisory key, held until commit, so the count and the write
// it guards are one atomic step.
//
// The per-actor guards ("cannot demote/delete yourself") do not add up to the
// invariant: two admins demoting each other concurrently each pass a self-only
// check and both writes land, leaving an install with no admin at all — and no
// in-app way to mint one, since both admin routes refuse to target the caller.
// Recovery would need host access to scripts/promote-admin.ts. A constant key
// may collide with a hashtext() user id in pg_advisory_xact_lock's single-int
// namespace; the only consequence is a little extra serialization.
export const ADMIN_GUARD_LOCK = 987_654_321;

// Transactions that may wait on ADMIN_GUARD_LOCK (or on the User row an erasure
// holds) must outlive the erasure that owns it: eraseUserArtifacts keeps the
// lock for up to 60s across its bounded storage sweep (`timeout: 60_000`). The
// role route and scripts/promote-admin.ts used Prisma's defaults (2s maxWait /
// 5s timeout), so an ordinary role change or the documented admin-recovery
// script issued while an account deletion was in flight aborted with P2028 —
// a masked 500 plus a captured incident for a transient lock wait (pass 51).
// 70s covers the erasure's own ceiling; 20s covers queuing behind it.
export const ADMIN_TX_OPTIONS = { timeout: 70_000, maxWait: 20_000 } as const;

// Rejects a mutation that would leave the install with no admin. Must run inside
// the same transaction as the write it guards, with the lock above taken first,
// and after the target's current role is known to be "admin".
export async function assertAnotherAdminRemains(
  tx: Prisma.TransactionClient,
  excludeUserId: string,
): Promise<void> {
  const others = await tx.user.count({ where: { role: "admin", id: { not: excludeUserId } } });
  if (others < 1) throw new Error("cannot-remove-last-admin: promote another admin first");
}
