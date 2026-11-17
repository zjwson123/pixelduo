import { Prisma } from "@prisma/client";
import { requireUserId, requireUserIdSession, ApiError } from "./api";
import { prisma } from "./prisma";
// Re-exported so every existing importer keeps its import site; the definitions
// live in a leaf module so scripts/promote-admin.ts can share the same lock
// without loading the request stack.
export { ADMIN_GUARD_LOCK, ADMIN_TX_OPTIONS, assertAnotherAdminRemains } from "./admin-guard";

// Operator gate for admin-only endpoints.
//
// Read-only routes keep this string form. Mutating routes use
// requireAdminSession so the transaction can re-prove the actor at commit time
// (pass 62): the gate at the top of a handler is a fact about the request when
// it STARTED, and a role change, erasure or revoke-sessions that commits while
// the handler waits on a lock does not retroactively cancel the write. For the
// routes that write an operator id onto other accounts' rows, that is also an
// erasure residue: the scrubbing erasure may have run before this transaction
// inserted its `actorId`.
export async function requireAdmin(): Promise<string> {
  return (await requireAdminSession()).id;
}

export interface AdminActor {
  id: string;
  /** The sessionVersion the request was authorized under. */
  sv: number;
}

export async function requireAdminSession(): Promise<AdminActor> {
  const { id, sv } = await requireUserIdSession();
  const user = await prisma.user.findUnique({ where: { id }, select: { role: true } });
  if (user?.role !== "admin") throw new ApiError(403, "admin-required");
  return { id, sv };
}

// Re-prove an admin actor inside the transaction that performs the write.
//
// Called AFTER the writes (just before commit) so the final state is what is
// checked: a demotion or erasure that committed while this transaction ran is
// visible (each statement takes a fresh snapshot), and the transaction rolls
// back. A plain read, not a lock: taking the actor's row lock here would add a
// new lock edge against every money writer that updates User credits, while the
// residue problem is already solved by checking after the writes — if erasure
// of the actor commits first, this sees it; if this transaction commits first,
// erasure's scrub runs afterwards and nulls the reference.
export async function assertAdminActorTx(
  tx: Prisma.TransactionClient | typeof prisma,
  actor: AdminActor,
): Promise<void> {
  const user = await tx.user.findUnique({
    where: { id: actor.id },
    select: { role: true, sessionVersion: true },
  });
  if (!user || user.role !== "admin") throw new ApiError(403, "admin-required");
  if (user.sessionVersion !== actor.sv) throw new ApiError(401, "unauthorized");
}
