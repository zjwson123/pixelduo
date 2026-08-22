import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../lib/prisma";
import { createMediaJob, completeJob, MAX_INFLIGHT_JOBS } from "../lib/queue";
import { grantCreditsTx } from "../lib/ledger";

// The queue itself supports unlimited concurrent jobs per user; the cap only
// stops one user from monopolizing the workers. Submitted jobs pre-auth
// credits, so the balance is the real spend guard.
let userId: string;

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `queue-cap-${Date.now()}@test.dev`, passwordHash: "x", name: "Queue Cap Test" },
  });
  userId = user.id;
  await prisma.$transaction((tx) => grantCreditsTx(tx, userId, "SIGNUP_BONUS", 500, null));
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { startsWith: "queue-cap-" } } });
  await prisma.$disconnect();
});

describe("per-user in-flight job cap", () => {
  it("rejects submissions beyond MAX_INFLIGHT_JOBS until a slot frees up", async () => {
    const mk = (prompt: string) =>
      createMediaJob({
        userId,
        model: "seedream",
        mediaType: "image",
        quality: "standard",
        count: 1,
        prompt,
      });

    const created = [];
    for (let i = 0; i < MAX_INFLIGHT_JOBS; i++) {
      const { job } = await mk(`cap job ${i}`);
      created.push(job);
    }

    await expect(mk("cap overflow")).rejects.toThrow(/queue-full/);

    // Terminal jobs free their slot: finish one, then submission works again
    await prisma.job.update({ where: { id: created[0].id }, data: { status: "running" } });
    await completeJob(created[0].id, [
      { url: "img/cap-done.png", model: "seedream", quality: "standard", credits: 6, prompt: "cap job 0" },
    ]);
    const { job: afterFree } = await mk("cap after free");
    expect(afterFree.status).toBe("queued");
    // Failed jobs must free their slot too
    await prisma.job.update({
      where: { id: afterFree.id },
      data: { status: "failed", attempts: 3, finishedAt: new Date() },
    });
    const { job: afterFail } = await mk("cap after fail");
    expect(afterFail.status).toBe("queued");

    // Cleanup: park the leftovers as terminal so parallel files' claim sweeps
    // don't keep churning them (user deletion cascades the rows anyway)
    await prisma.job.updateMany({
      where: { id: { in: [afterFail.id, ...created.slice(1).map((j) => j.id)] } },
      data: { status: "failed", attempts: 3, finishedAt: new Date() },
    });
  });
});
