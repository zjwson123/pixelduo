import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../lib/prisma";
import { createMediaJob } from "../lib/queue";
import { grantCreditsTx } from "../lib/ledger";

// Client-supplied idempotency keys must be scoped per user: Job.idempotencyKey
// is globally unique, so an un-namespaced key would let user B retrieve user
// A's job (id/status/cost) by submitting A's key.
let userA: string;
let userB: string;

beforeAll(async () => {
  const [a, b] = await Promise.all([
    prisma.user.create({
      data: { email: `idem-a-${Date.now()}@test.dev`, passwordHash: "x", name: "Idem A" },
    }),
    prisma.user.create({
      data: { email: `idem-b-${Date.now()}@test.dev`, passwordHash: "x", name: "Idem B" },
    }),
  ]);
  userA = a.id;
  userB = b.id;
  await Promise.all(
    [userA, userB].map((id) =>
      prisma.$transaction((tx) => grantCreditsTx(tx, id, "SIGNUP_BONUS", 500, null)),
    ),
  );
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { contains: "idem-" } } });
  await prisma.$disconnect();
});

describe("idempotency key scoping", () => {
  it("same client key from different users creates separate jobs", async () => {
    const key = `client-key-${Date.now()}`;
    const ra = await createMediaJob({
      userId: userA,
      model: "seedream",
      mediaType: "image",
      quality: "standard",
      count: 1,
      prompt: "a mug",
      idempotencyKey: key,
    });
    const rb = await createMediaJob({
      userId: userB,
      model: "seedream",
      mediaType: "image",
      quality: "standard",
      count: 1,
      prompt: "a different mug",
      idempotencyKey: key,
    });
    expect(ra.created).toBe(true);
    expect(rb.created).toBe(true);
    expect(rb.job.id).not.toBe(ra.job.id);
    expect(rb.job.userId).toBe(userB);
  });

  it("same user resubmitting the same key still dedupes", async () => {
    const key = `same-user-key-${Date.now()}`;
    const opts = {
      userId: userA,
      model: "seedream" as const,
      mediaType: "image" as const,
      quality: "standard" as const,
      count: 1,
      prompt: "one mug",
    };
    const r1 = await createMediaJob({ ...opts, idempotencyKey: key });
    const r2 = await createMediaJob({ ...opts, idempotencyKey: key });
    expect(r1.created).toBe(true);
    expect(r2.created).toBe(false);
    expect(r2.job.id).toBe(r1.job.id);
  });
});
