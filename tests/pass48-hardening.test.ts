import { afterAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "crypto";

// ---------------------------------------------------------------------------
// Pass 48 — two read-side gaps left by the two previous fixes.
//
//  1. Pass 47 masked credential-shaped material in Job.error at WRITE time
//     (failJob). Rows recorded before that deploy are still in the column, and
//     three API views hand the value to the job's owner verbatim: /api/jobs,
//     /api/jobs/[id] and the v1 poll. A gateway that echoed the request's
//     Authorization header — the exact case pass 47 was written for — therefore
//     still delivers the operator's provider credential to the customer until
//     the row ages out. The account export returns the same column.
//
//  2. Passes 43/44 taught /api/account/export to use explicit selects for the
//     ledger and feedback rows (operator ids), but jobs/images/orders still
//     returned EVERY column. Job.worker is `worker-<hostname>-<pid>-<uuid>`, so
//     the export handed every user the deployment's hostname and process ids;
//     the scheduling columns, the idempotency key, the credit-consumption map
//     and the provider's task id rode along with it.
// ---------------------------------------------------------------------------

const getServerSession = vi.fn();
vi.mock("next-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-auth")>();
  return { ...actual, getServerSession: (...args: unknown[]) => getServerSession(...args) };
});

const { prisma } = await import("../lib/prisma");
const { redactJobError } = await import("../lib/queue");
const { hashApiKey } = await import("../lib/apikey");
const { POST: exportPost } = await import("../app/api/account/export/route");
const { GET: jobsListGet } = await import("../app/api/jobs/route");
const { GET: jobGet } = await import("../app/api/jobs/[id]/route");
const { GET: v1PollGet } = await import("../app/api/v1/images/generations/[id]/route");

const tag = `pass48-${Date.now()}`;
let seq = 0;

async function makeUser(extra: Record<string, unknown> = {}) {
  return prisma.user.create({
    data: { email: `${tag}-${seq++}@test.dev`, passwordHash: "x", name: "Pass 48", ...extra },
  });
}

function session(user: { id: string }, sv = 0) {
  getServerSession.mockResolvedValue({ user: { id: user.id, sv, totpPending: false } });
}

// A provider echo of the request's credential, in the shapes pass 47 masks.
const SENTINEL = "sk-live-LEGACY-abcdef123456";
const LEGACY_ERROR = `upstream 401: Authorization: Bearer ${SENTINEL} — contact owner@example.com`;

afterAll(async () => {
  // ApiKey has no FK to User (hash-only table — see prisma/schema.prisma), so
  // the cascade does not reach it; delete the keys this run minted explicitly.
  const users = await prisma.user.findMany({ where: { email: { startsWith: tag } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  if (ids.length > 0) await prisma.apiKey.deleteMany({ where: { userId: { in: ids } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: tag } } });
  await prisma.$disconnect();
});

describe("pass 48 — Job.error is masked on every read, not only at write time", () => {
  it("redacts a legacy value and is idempotent", () => {
    expect(redactJobError(null)).toBeNull();
    expect(redactJobError(undefined)).toBeNull();
    expect(redactJobError("video generation failed: 400 bad request")).toBe(
      "video generation failed: 400 bad request",
    );
    const once = redactJobError(LEGACY_ERROR);
    expect(once).not.toContain(SENTINEL);
    expect(once).not.toContain("owner@example.com");
    expect(once).toContain("[REDACTED]");
    // A second pass must not change what the first produced (the write-time
    // mask and this one can both have seen the value).
    expect(redactJobError(once)).toBe(once);
  });

  it("covers the jobs list, the job detail, the v1 poll and the export", async () => {
    const user = await makeUser({ emailVerified: new Date() });
    session(user);
    // A retried job is `queued` AND carries its last attempt's error, so the
    // list path returns it; the failed one is the detail path's shape.
    const retrying = await prisma.job.create({
      data: {
        userId: user.id,
        status: "queued",
        model: "gpt",
        mediaType: "image",
        quality: "medium",
        count: 1,
        prompt: "legacy",
        costCredits: 8,
        images: "[]",
        error: LEGACY_ERROR,
      },
    });
    const failed = await prisma.job.create({
      data: {
        userId: user.id,
        status: "failed",
        model: "gpt",
        mediaType: "image",
        quality: "medium",
        count: 1,
        prompt: "legacy",
        costCredits: 8,
        images: "[]",
        error: LEGACY_ERROR,
        finishedAt: new Date(),
      },
    });

    const list = await jobsListGet();
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { jobs: Array<{ id: string; error: string | null }> };
    const listed = listBody.jobs.find((j) => j.id === retrying.id);
    expect(listed).toBeDefined();
    expect(listed!.error).not.toContain(SENTINEL);
    expect(listed!.error).toContain("[REDACTED]");

    const detail = await jobGet(new Request(`http://localhost/api/jobs/${failed.id}`), {
      params: Promise.resolve({ id: failed.id }),
    });
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as { job: { error: string | null } };
    expect(detailBody.job.error).not.toContain(SENTINEL);
    expect(detailBody.job.error).toContain("[REDACTED]");

    // The public API authenticates with a Bearer key, not the cookie. The raw
    // value is random because keyHash is unique and the row outlives this
    // user's cascade (no FK) — a fixed value made a second suite run collide.
    const rawKey = `pd_live_${randomBytes(24).toString("hex")}`;
    await prisma.apiKey.create({
      data: {
        userId: user.id,
        name: "pass48",
        keyHash: hashApiKey(rawKey),
        prefix: rawKey.slice(0, 12),
        sessionVersion: 0,
      },
    });
    const poll = await v1PollGet(
      new Request(`http://localhost/api/v1/images/generations/${failed.id}`, {
        headers: { authorization: `Bearer ${rawKey}` },
      }),
      { params: Promise.resolve({ id: failed.id }) },
    );
    expect(poll.status).toBe(200);
    const pollBody = (await poll.json()) as { job: { error: string | null } };
    expect(pollBody.job.error).not.toContain(SENTINEL);
    expect(pollBody.job.error).toContain("[REDACTED]");

    const exported = await exportPost(new Request("http://localhost/api/account/export", { method: "POST" }));
    expect(exported.status).toBe(200);
    const exportBody = (await exported.json()) as {
      data: { jobs: Array<{ id: string; error: string | null }> };
    };
    const exportedFailed = exportBody.data.jobs.find((j) => j.id === failed.id);
    expect(exportedFailed).toBeDefined();
    expect(exportedFailed!.error).not.toContain(SENTINEL);
    expect(exportedFailed!.error).toContain("[REDACTED]");
    expect(JSON.stringify(exportBody)).not.toContain(SENTINEL);
  });
});

describe("pass 48 — the data export carries the user's data, not the queue's internals", () => {
  it("omits the worker id, scheduling/credit bookkeeping and provider handles", async () => {
    const user = await makeUser({ emailVerified: new Date() });
    session(user);

    const job = await prisma.job.create({
      data: {
        userId: user.id,
        status: "done",
        model: "seedance",
        mediaType: "video",
        quality: "standard",
        count: 1,
        prompt: "a calm lake",
        costCredits: 56,
        images: JSON.stringify(["img/out.mp4"]),
        durationSec: 4,
        // Everything the export must not carry.
        worker: "worker-prod-app-7-4242-abcd1234",
        heartbeatAt: new Date(),
        nextAttemptAt: new Date(Date.now() + 60_000),
        attempts: 2,
        maxAttempts: 3,
        taskCreatedAt: new Date(),
        providerTaskId: "task-upstream-xyz",
        idempotencyKey: `${tag}-idem-job`,
        consumption: [{ grantId: "grant-internal-id", amount: 56 }],
        finishedAt: new Date(),
      },
    });
    await prisma.image.create({
      data: {
        userId: user.id,
        jobId: job.id,
        url: "img/out.mp4",
        model: "seedance",
        quality: "standard",
        prompt: "a calm lake",
        credits: 56,
      },
    });
    await prisma.order.create({
      data: {
        userId: user.id,
        kind: "pack",
        provider: "mock",
        providerOrderId: "pi_internal_123",
        amountUsd: 4.99,
        credits: 400,
        status: "paid",
        paidAt: new Date(),
        idempotencyKey: `${tag}-idem-order`,
        collectedAmountUsd: 4.99,
        refundedAmountUsd: 1,
        disputedAmountUsd: 2,
        refundedAdjustments: ["adj-1:approved"],
        disputedAdjustments: ["disputed:dp-1"],
        disputeReinstatements: ["reinstated:dp-2"],
      },
    });

    const res = await exportPost(new Request("http://localhost/api/account/export", { method: "POST" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        jobs: Array<Record<string, unknown>>;
        images: Array<Record<string, unknown>>;
        orders: Array<Record<string, unknown>>;
      };
    };

    const jobRow = body.data.jobs.find((j) => j.id === job.id)!;
    expect(jobRow).toBeDefined();
    for (const internal of [
      "worker",
      "heartbeatAt",
      "nextAttemptAt",
      "attempts",
      "maxAttempts",
      "taskCreatedAt",
      "providerTaskId",
      "idempotencyKey",
      "consumption",
    ]) {
      expect(jobRow).not.toHaveProperty(internal);
    }
    // The user's own generation record stays.
    expect(jobRow.prompt).toBe("a calm lake");
    expect(jobRow.status).toBe("done");
    expect(jobRow.durationSec).toBe(4);
    expect(jobRow.images).toBe(JSON.stringify(["img/out.mp4"]));

    const imageRow = body.data.images.find((i) => i.url === "img/out.mp4")!;
    expect(imageRow).toBeDefined();
    // Their own user id is redundant beside data.user.id; the row's jobId and
    // storage key are theirs and stay.
    expect(imageRow).not.toHaveProperty("userId");
    expect(imageRow.jobId).toBe(job.id);

    const orderRow = body.data.orders[0];
    expect(orderRow).toBeDefined();
    for (const internal of [
      "providerOrderId",
      "idempotencyKey",
      "refundedAdjustments",
      "disputedAdjustments",
      "disputeReinstatements",
    ]) {
      expect(orderRow).not.toHaveProperty(internal);
    }
    // Money facts about the customer's own order stay.
    expect(orderRow.amountUsd).toBe(4.99);
    expect(orderRow.collectedAmountUsd).toBe(4.99);
    expect(orderRow.refundedAmountUsd).toBe(1);
    expect(orderRow.disputedAmountUsd).toBe(2);

    // Nothing above may appear anywhere in the serialized body.
    const serialized = JSON.stringify(body);
    for (const leak of ["worker-prod-app-7-4242-abcd1234", "task-upstream-xyz", "pi_internal_123", "grant-internal-id"]) {
      expect(serialized).not.toContain(leak);
    }
  });
});
