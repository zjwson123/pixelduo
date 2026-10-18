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

// A worker committed an artifact between the pre-delete sweep and the locked
// re-read. The caller deletes the new keys and tries again; the Job row locks
// in that transaction stop any further completion from committing after the
// re-read, so a second pass is the last one that can find anything.
export class ErasureArtifactsAppeared extends Error {
  constructor(public keys: string[]) {
    super("erasure-artifacts-appeared");
  }
}

// Delete every object the account names, then verify under the transaction's
// locks that nothing new appeared before removing the rows. Returns only after
// the transaction that deletes the account rows commits.
//
// Storage failures are NOT swallowed: the previous code ignored every
// deleteObjectsBounded result while the drivers' delete() caught every error,
// so a transient bucket fault produced `{deleted:true}` with the objects still
// in the bucket and the rows that named them gone — permanently unretryable and
// contrary to the privacy policy. A failure now aborts BEFORE the rows are
// deleted, so the customer can retry the erasure.
export interface ErasureSteps {
  // Take the row locks FIRST, in the order every writer uses (Order → Job →
  // CreditGrant → User), and run the same presence/last-admin checks inside the
  // transaction. The locked re-read below is only meaningful when nothing can
  // commit a new artifact behind it.
  lockRows: (tx: Prisma.TransactionClient) => Promise<void>;
  // Remove the account's rows. Runs after the re-read, under the same locks.
  deleteRows: (tx: Prisma.TransactionClient) => Promise<void>;
}

export async function eraseUserArtifacts(
  userId: string,
  steps: ErasureSteps,
  opts: { attempts?: number; onStorageFailure: (keys: string[]) => void } = {
    onStorageFailure: () => undefined,
  },
): Promise<void> {
  const attempts = opts.attempts ?? 3;
  let deletedKeys = new Set<string>();
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const keys = await collectUserArtifactKeys(prisma, userId);
    const outcome = await deleteObjectsBounded(keys);
    if (outcome.failed > 0) {
      opts.onStorageFailure(keys.filter((k) => !outcome.deletedKeys.has(k)));
      throw new ApiError(
        503,
        "cannot-delete-storage: some stored files could not be deleted — nothing was erased, retry the request",
      );
    }
    deletedKeys = new Set([...deletedKeys, ...keys]);
    try {
      await withDeadlockRetry(() =>
        prisma.$transaction(async (tx) => {
          // Locks BEFORE the verification read: a worker that committed its
          // Image row before the Job lock is seen here (and forces one more
          // sweep); one that tries after it blocks and then loses its own CAS
          // because the row is gone.
          await steps.lockRows(tx);
          const appeared = (await collectUserArtifactKeys(tx, userId)).filter(
            (k) => !deletedKeys.has(k),
          );
          if (appeared.length > 0) throw new ErasureArtifactsAppeared(appeared);
          await steps.deleteRows(tx);
        }),
      );
      return;
    } catch (e) {
      if (e instanceof ErasureArtifactsAppeared) {
        if (attempt < attempts) continue;
        throw new ApiError(
          503,
          "cannot-delete-storage: new files kept appearing while the account was erased — retry the request",
        );
      }
      throw e;
    }
  }
}
