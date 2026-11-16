import type { Prisma } from "@prisma/client";
import { prisma, withDeadlockRetry } from "./prisma";
import { ApiError } from "./api";
import { checkpointKeys } from "./queue";
import { deleteObjectsBounded } from "./storage";

// Everything an account's own rows still name in object storage.
//
// Extracted so the two erasure routes (self-service and admin) ask the same
// question, and so the same question can be asked again INSIDE the delete
// transaction, under the Job/Order locks (pass 39). Before this, the key
// snapshot was taken outside the transaction: a worker completing a job in the
// window wrote an Image row that the cascade then removed while its object was
// never in the delete list — the blob outlived the erasure, and no row named it
// any more.
export async function collectUserArtifactKeys(
  client: Prisma.TransactionClient | typeof prisma,
  userId: string,
): Promise<string[]> {
  const [images, jobs] = await Promise.all([
    client.image.findMany({ where: { userId }, select: { url: true } }),
    client.job.findMany({
      where: { userId },
      select: { refImageKey: true, images: true, sourceVideoKey: true },
    }),
  ]);
  const keys = new Set<string>();
  for (const i of images) if (i.url) keys.add(i.url);
  for (const j of jobs) {
    if (j.refImageKey) keys.add(j.refImageKey);
    if (j.sourceVideoKey) keys.add(j.sourceVideoKey);
    for (const k of checkpointKeys(j.images)) keys.add(k);
  }
  return [...keys];
}

// Delete every object the account names, then remove the rows — all inside ONE
// transaction, after `lockRows` has proved the caller may still erase.
//
// Pass 43 inverted the order. The sweep used to run BEFORE the transaction, so
// a request that passed the password/2FA checks deleted every stored artifact
// and only then hit the sessionVersion CAS inside the transaction: a
// revoke-sessions or password reset arriving during the (documented,
// multi-second) sweep won the CAS, the account survived, and the files were
// already gone with no way to restore them. A revoked session must not delete
// anything, whether the revocation arrives before or during the sweep.
//
// Holding the row locks across the storage round trips serializes the sweep
// against every writer that can still name an artifact (completeJob takes
// Order → Job → …), and the caller locks the User row LAST — the position every
// money writer already uses — so an sv bump blocks until this commits or aborts.
//
// Storage failures are NOT swallowed (pass 39): the drivers reject on every
// real error and treat a missing key as success, so a transient bucket fault
// aborts the transaction BEFORE the rows are deleted and the customer can
// retry. The transaction timeout is generous because the sweep is network I/O;
// 60s covers a large library at the bounded concurrency of
// deleteObjectsBounded, and a timeout rolls the row deletes back, leaving the
// account intact (only objects already deleted are unrecoverable — the
// unavoidable residue of any external side effect).
export interface ErasureSteps {
  // Take the row locks FIRST, in the order every writer uses (Order → Job →
  // CreditGrant → User), re-check the authorization while holding them, and run
  // the same presence/last-admin checks inside the transaction.
  lockRows: (tx: Prisma.TransactionClient) => Promise<void>;
  // Remove the account's rows. Runs after the storage sweep, under the same
  // locks.
  deleteRows: (tx: Prisma.TransactionClient) => Promise<void>;
}

// Remove this account's User.id from rows OTHER accounts own (pass 61).
//
// LedgerEntry.actorId, an admin grant's refId and Feedback.handledBy are plain
// strings with no foreign key — deliberately, so the audit trail survives an
// operator's own row changes — which also means the User cascade cannot reach
// them. Erasing an admin therefore left their primary key on every account they
// had granted credits to or closed feedback for, after the erasure promised the
// account was gone. The application never returns those columns to the affected
// users today (the export nulls admin refIds, /api/ledger omits actorId), so
// this is erasure completeness rather than a live disclosure — but the residue
// is exactly what an erasure request is about.
export async function scrubOperatorReferencesTx(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<void> {
  await tx.ledgerEntry.updateMany({ where: { actorId: userId }, data: { actorId: null } });
  await tx.ledgerEntry.updateMany(
    { where: { refType: "admin", refId: userId }, data: { refId: null } },
  );
  await tx.creditGrant.updateMany(
    { where: { refType: "admin", refId: userId }, data: { refId: null } },
  );
  await tx.feedback.updateMany({ where: { handledBy: userId }, data: { handledBy: null } });
}

export async function eraseUserArtifacts(
  userId: string,
  steps: ErasureSteps,
  opts: { attempts?: number; onStorageFailure: (keys: string[]) => void } = {
    onStorageFailure: () => undefined,
  },
): Promise<void> {
  const rounds = opts.attempts ?? 3;
  await withDeadlockRetry(() =>
    prisma.$transaction(
      async (tx) => {
        await steps.lockRows(tx);
        const deletedKeys = new Set<string>();
        for (let round = 0; round < rounds; round++) {
          const keys = (await collectUserArtifactKeys(tx, userId)).filter(
            (k) => !deletedKeys.has(k),
          );
          if (keys.length === 0) {
            await steps.deleteRows(tx);
            return;
          }
          const outcome = await deleteObjectsBounded(keys);
          if (outcome.failed > 0) {
            opts.onStorageFailure(keys.filter((k) => !outcome.deletedKeys.has(k)));
            throw new ApiError(
              503,
              "cannot-delete-storage: some stored files could not be deleted — nothing was erased, retry the request",
            );
          }
          for (const k of outcome.deletedKeys) deletedKeys.add(k);
        }
        // The Job lock makes a new artifact impossible after lockRows, so this
        // only fires if the sweep kept discovering keys for another reason.
        throw new ApiError(
          503,
          "cannot-delete-storage: new files kept appearing while the account was erased — retry the request",
        );
      },
      { timeout: 60_000, maxWait: 15_000 },
    ),
  );
}
