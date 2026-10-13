import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";
import { createHmac } from "crypto";
import { encode } from "next-auth/jwt";
import { prisma } from "../lib/prisma";
import { grantCreditsTx } from "../lib/ledger";

// Pass 36. Four domain audits (money, queue/worker, HTTP surface, ops) over
// b4dde22, and every case below was reproduced with a probe before it was
// fixed. The classes: a witness that named the wrong cycle, a dedupe key that
// a provider can change, a fenced writer with one unfenced sibling, a
// credential that re-dated itself, and three helpers that failed open.

const stamp = Date.now();
let seq = 0;

async function makeUser(tag: string, extra: Record<string, unknown> = {}) {
  const { credits, ...rest } = extra as { credits?: number } & Record<string, unknown>;
  const user = await prisma.user.create({
    data: {
      email: `p36-${tag}-${stamp}-${seq++}@test.dev`,
      passwordHash: "x",
      emailVerified: new Date(),
      ...rest,
    },
  });
  if (credits) {
    // spendCreditsTx draws on GRANTS, not on the balance column: a user with
    // credits but no grant answers insufficient-credits to every job.
    await prisma.$transaction((tx) => grantCreditsTx(tx, user.id, "PURCHASE", credits, null));
  }
  return user;
}

async function makePlanOrder(userId: string, credits = 2000, planId = "pro") {
  return prisma.order.create({
    data: {
      userId,
      kind: "plan",
      status: "pending",
      amountUsd: 19,
      credits,
      planId,
      provider: "mock",
      providerOrderId: `mock_p36_${stamp}_${seq++}`,
      idempotencyKey: `p36-${stamp}-${seq++}`,
    },
  });
}

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { contains: `p36-${stamp}` } } });
  await prisma.order.deleteMany({ where: { idempotencyKey: { contains: `p36-${stamp}` } } });
  await prisma.paymentEvent.deleteMany({ where: { eventId: { contains: `p36_${stamp}` } } });
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// 1. Money: a legacy cycle's carryover no longer deletes the NEXT cycle's
// ---------------------------------------------------------------------------
describe("pass 36 — the rollover witness names the measured cycle, not the incoming order", () => {
  // Flow: cycle L (LEGACY: the grant has no refType/refId, the shape every
  // subscription that predates migration 20260811080000 still has) ends →
  // renewal with order O1 mints L's carryover, stamped with the INCOMING order
  // (the fallback in fulfillOrder, because there is no funding order to name) →
  // cycle 1 (funded by O1) ends → the renewal must mint cycle 1's own 30%.
  //
  // Pre-fix the witness OR'd a refId leg, so it found L's carryover (refId =
  // O1) while measuring cycle 1 and read it as "already paid for this cycle":
  // the carryover was silently deleted and the customer collected it a cycle
  // late. The leg is gone in the state where a cycle actually ends by its own
  // deadline; the time bound (createdAt >= the measured expiry) is the cycle's
  // identity, and it cannot name an earlier cycle's carryover.
  async function scenario(tag: string, legacy: boolean) {
    const user = await makeUser(`roll-${tag}`);
    const uid = user.id;
    const order0 = legacy ? null : await makePlanOrder(uid);
    const { addCreditsTx } = await import("../lib/ledger");
    await prisma.$transaction(async (tx) => {
      await tx.creditGrant.create({
        data: {
          userId: uid,
          source: "SUBSCRIPTION",
          amount: 2000,
          remaining: 2000,
          expiresAt: new Date(Date.now() - 2 * 60_000),
          refType: order0 ? "order" : null,
          refId: order0 ? order0.id : null,
        },
      });
      await addCreditsTx(tx, uid, "SUBSCRIPTION", 2000, order0 ? "order" : null, order0?.id ?? null, "cycle 0");
    });

    const { fulfillOrder } = await import("../lib/ledger");
    const o1 = await makePlanOrder(uid);
    await fulfillOrder(uid, o1.id, "plan", 2000, "pro");
    const g1 = await prisma.creditGrant.findFirstOrThrow({
      where: { userId: uid, source: "SUBSCRIPTION", refId: o1.id },
      select: { id: true },
    });

    // Cycle 1 ends on its own deadline, and the carryover minted at the last
    // renewal was minted BEFORE that deadline (its real timeline).
    const ended = new Date(Date.now() - 10 * 60_000);
    await prisma.creditGrant.update({ where: { id: g1.id }, data: { expiresAt: ended } });
    await prisma.user.update({ where: { id: uid }, data: { planRenewsAt: ended } });
    await prisma.creditGrant.updateMany({
      where: { userId: uid, source: "ROLLOVER" },
      data: { createdAt: new Date(Date.now() - 20 * 60_000) },
    });

    const o2 = await makePlanOrder(uid);
    await fulfillOrder(uid, o2.id, "plan", 2000, "pro");
    const rolls = await prisma.creditGrant.findMany({
      where: { userId: uid, source: "ROLLOVER" },
      select: { amount: true, refId: true },
    });
    return { uid, o1Id: o1.id, o2Id: o2.id, total: rolls.reduce((s, r) => s + r.amount, 0), rows: rolls.length };
  }

  it("pays the first funded cycle's carryover after a legacy cycle", async () => {
    const legacy = await scenario("legacy", true);
    // Pre-fix: 600 (only the legacy cycle's) — cycle 1's 30% of 2000 was
    // suppressed by the carryover stamped with cycle 1's own funding order.
    expect(legacy.rows).toBe(2);
    expect(legacy.total).toBe(1200);
  });

  it("control: an order-funded cycle behaves the same (no regression there)", async () => {
    const control = await scenario("control", false);
    expect(total(control)).toBe(1200);
  });

  function total(s: { total: number }) {
    return s.total;
  }
});

// ---------------------------------------------------------------------------
// 2. Money: an operator clawback reduces the cycle's carryover
// ---------------------------------------------------------------------------
describe("pass 36 — a clawed-back cycle's quota is not carried over", () => {
  it("counts the clawback against the measured cycle, and records who took it", async () => {
    const { fulfillOrder, adminClawbackTx } = await import("../lib/ledger");
    const user = await makeUser("claw");
    const uid = user.id;
    const o1 = await makePlanOrder(uid);
    await fulfillOrder(uid, o1.id, "plan", 2000, "pro");
    // The whole 2000-credit quota, clawed back by an operator.
    await prisma.$transaction((tx) => adminClawbackTx(tx, uid, 2000, "probe clawback", "admin-p36"));

    const row = await prisma.ledgerEntry.findFirstOrThrow({
      where: { userId: uid, type: "ADMIN", creditsDelta: -2000 },
    });
    // The row names the ORDER the credits came from (so the measurement can
    // see the clawback) AND the operator (LedgerEntry.actorId) — the two facts
    // one (refType, refId) slot cannot hold at once, which is why the column
    // exists. Pre-fix: refType "admin" / refId "admin-p36" and no actorId.
    expect(row.refType).toBe("order");
    expect(row.refId).toBe(o1.id);
    expect(row.actorId).toBe("admin-p36");

    const g1 = await prisma.creditGrant.findFirstOrThrow({
      where: { userId: uid, source: "SUBSCRIPTION", refId: o1.id },
      select: { id: true },
    });
    const ended = new Date(Date.now() - 10 * 60_000);
    await prisma.creditGrant.update({ where: { id: g1.id }, data: { expiresAt: ended } });
    await prisma.user.update({ where: { id: uid }, data: { planRenewsAt: ended } });
    const o2 = await makePlanOrder(uid);
    await fulfillOrder(uid, o2.id, "plan", 2000, "pro");

    // Pre-fix: 600 — 30% of quota the account no longer had, re-granted at the
    // next renewal, repeatable every cycle an operator takes quota back.
    const rolls = await prisma.creditGrant.findMany({
      where: { userId: uid, source: "ROLLOVER" },
      select: { amount: true },
    });
    expect(rolls.reduce((s, r) => s + r.amount, 0)).toBe(0);
  });

  it("control: an untouched cycle still carries 30% over", async () => {
    const { fulfillOrder } = await import("../lib/ledger");
    const user = await makeUser("claw-control");
    const uid = user.id;
    const o1 = await makePlanOrder(uid);
    await fulfillOrder(uid, o1.id, "plan", 2000, "pro");
    const g1 = await prisma.creditGrant.findFirstOrThrow({
      where: { userId: uid, source: "SUBSCRIPTION", refId: o1.id },
      select: { id: true },
    });
    const ended = new Date(Date.now() - 10 * 60_000);
    await prisma.creditGrant.update({ where: { id: g1.id }, data: { expiresAt: ended } });
    await prisma.user.update({ where: { id: uid }, data: { planRenewsAt: ended } });
    const o2 = await makePlanOrder(uid);
    await fulfillOrder(uid, o2.id, "plan", 2000, "pro");
    const rolls = await prisma.creditGrant.findMany({
      where: { userId: uid, source: "ROLLOVER" },
      select: { amount: true },
    });
    expect(rolls.reduce((s, r) => s + r.amount, 0)).toBe(600);
  });
});

// ---------------------------------------------------------------------------
// 3. Money: one Paddle adjustment delivered twice is counted once
// ---------------------------------------------------------------------------
describe("pass 36 — the refund accumulator keys on the adjustment, not the notification", () => {
  const PADDLE_SECRET = "pdl_whsec_p36_test";
  const savedEnv = {
    provider: process.env.PAYMENT_PROVIDER,
    key: process.env.PADDLE_API_KEY,
    secret: process.env.PADDLE_WEBHOOK_SECRET,
  };

  function sign(payload: string, ts = Math.floor(Date.now() / 1000)): string {
    const h1 = createHmac("sha256", PADDLE_SECRET).update(`${ts}:${payload}`).digest("hex");
    return `ts=${ts};h1=${h1}`;
  }

  function request(eventType: string, eventId: string, data: Record<string, unknown>): Request {
    const payload = JSON.stringify({
      event_id: eventId,
      event_type: eventType,
      occurred_at: new Date().toISOString(),
      data,
    });
    return new Request("http://localhost/api/webhooks/payment", {
      method: "POST",
      headers: { "content-type": "application/json", "paddle-signature": sign(payload) },
      body: payload,
    });
  }

  function adjustment(
    id: string,
    overrides: Record<string, unknown>,
    transactionId = `txn_p36_${stamp}`,
  ): Record<string, unknown> {
    return {
      id,
      action: "refund",
      status: "approved",
      type: "partial",
      transaction_id: transactionId,
      currency_code: "USD",
      items: [],
      totals: { subtotal: "2500", tax: "0", total: "2500", fee: "0", earnings: "0", currency_code: "USD" },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...overrides,
    };
  }

  beforeAll(async () => {
    process.env.PAYMENT_PROVIDER = "paddle";
    process.env.PADDLE_API_KEY = "pdl_sdbx_p36_dummy";
    process.env.PADDLE_WEBHOOK_SECRET = PADDLE_SECRET;
    const { _resetPaymentProviderForTests } = await import("../lib/payments");
    _resetPaymentProviderForTests();
  });

  afterAll(async () => {
    const { _resetPaymentProviderForTests } = await import("../lib/payments");
    _resetPaymentProviderForTests();
    for (const [k, v] of [
      ["PAYMENT_PROVIDER", savedEnv.provider],
      ["PADDLE_API_KEY", savedEnv.key],
      ["PADDLE_WEBHOOK_SECRET", savedEnv.secret],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  async function paidOrder(tag: string) {
    // No credits from makeUser: the order's own grant IS the balance here.
    const user = await makeUser(tag);
    const order = await prisma.order.create({
      data: {
        userId: user.id,
        kind: "pack",
        status: "paid",
        amountUsd: 49.99,
        credits: 6000,
        provider: "paddle",
        providerOrderId: `txn_p36_${stamp}_${seq++}`,
        idempotencyKey: `p36-${stamp}-${seq++}`,
      },
    });
    await prisma.$transaction((tx) => grantCreditsTx(tx, user.id, "PURCHASE", 6000, null, "order", order.id));
    return { user, order };
  }

  it("does not promote a partial refund whose adjustment is re-delivered", async () => {
    const { POST } = await import("../app/api/webhooks/payment/route");
    const { user, order } = await paidOrder("paddle-dup");
    const txn = order.providerOrderId as string;

    // TWO deliveries of ONE $25 partial from a $49.99 order, each with its own
    // notification id — what any second update of the same adjustment produces.
    // Pre-fix both accumulated ($25 + $25 >= $49.99) and promoted a partial
    // refund to a FULL revoke: credits and the paid tier gone for money the
    // customer still holds (probed through this route).
    const first = await POST(request("adjustment.updated", `ntf_p36_${stamp}_a`, adjustment(`adj_p36_dup_${stamp}`, {}, txn)));
    expect(first.status).toBe(200);
    const second = await POST(request("adjustment.updated", `ntf_p36_${stamp}_b`, adjustment(`adj_p36_dup_${stamp}`, {}, txn)));
    expect(second.status).toBe(200);

    const afterDup = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(afterDup.refundedAmountUsd).toBe(25);
    expect(afterDup.status).toBe("paid");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).credits).toBe(6000);
    expect(
      (await prisma.creditGrant.findMany({ where: { userId: user.id } })).reduce((s, g) => s + g.remaining, 0),
    ).toBe(6000);

    // Control: a SECOND, DISTINCT adjustment still accumulates — the pair now
    // reaches the price and revokes, exactly as the partial-refund protection
    // (pass 32) intends.
    const third = await POST(
      request("adjustment.updated", `ntf_p36_${stamp}_c`, adjustment(`adj_p36_other_${stamp}`, {}, txn)),
    );
    expect(third.status).toBe(200);
    const afterSecond = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(afterSecond.refundedAmountUsd).toBe(50);
    expect(afterSecond.status).toBe("refunded");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).credits).toBe(0);
  });

  it("applies an adjustment's reversal once, so a duplicate cannot eat a later refund", async () => {
    const { POST } = await import("../app/api/webhooks/payment/route");
    const { order } = await paidOrder("paddle-rev");
    const txn = order.providerOrderId as string;

    const adj = `adj_p36_rev_${stamp}`;
    await POST(request("adjustment.updated", `ntf_p36_${stamp}_r1`, adjustment(adj, {}, txn)));
    // The reversal of that adjustment: same id, status reversed, negative delta.
    await POST(request("adjustment.updated", `ntf_p36_${stamp}_r2`, adjustment(adj, { status: "reversed" }, txn)));
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).refundedAmountUsd).toBe(0);
    // A different adjustment brings the total back to $25...
    await POST(request("adjustment.updated", `ntf_p36_${stamp}_r3`, adjustment(`adj_p36_rev2_${stamp}`, {}, txn)));
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).refundedAmountUsd).toBe(25);
    // ...and the SAME reversal delivered again must be a no-op. Pre-fix it
    // subtracted a second time (floored at zero), so a later genuine partial
    // failed to reach the price and the full refund left the credits granted —
    // the pass-33 shape, reachable again through the duplicate.
    await POST(request("adjustment.updated", `ntf_p36_${stamp}_r4`, adjustment(adj, { status: "reversed" }, txn)));
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).refundedAmountUsd).toBe(25);
  });
});

// ---------------------------------------------------------------------------
// 4. Queue: a slow bucket cannot roll back the terminal refund
// ---------------------------------------------------------------------------
describe("pass 36 — failJob's artifact reclaim cannot veto the money", () => {
  // The deletes used to run INSIDE the interactive transaction that flips the
  // job terminal and refunds it. The S3 driver allows 30s per request, there
  // can be five objects, and Prisma's interactive-transaction budget is 5000ms:
  // a merely slow bucket aborted the transaction and rolled back the whole
  // terminal transition — job still running, pre-auth still held, inflight slot
  // still occupied, and every later sweep reproduced it (probed: 3s/delete →
  // 6.0s > 5000ms → status=running, balance unchanged). The witness here is
  // the same one the probe used: the fake bucket answers each DELETE with a
  // delay, and on the FIRST delete reads the job row through the app's own
  // connection. Committed-before-cleanup reads `failed`; cleanup-inside-the-
  // transaction reads `running` (its write is not visible yet).
  let server: import("http").Server;
  let s3Port = 0;
  const observed: string[] = [];
  let slot: { jobId: string } | null = null;

  beforeAll(async () => {
    const http = await import("http");
    server = http.createServer((req, res) => {
      // Any S3 request: answer after a delay long enough to blow a 5s budget
      // when several of them are awaited inside one transaction. The first
      // DELETE also reports what the job looks like from outside that
      // transaction.
      if (req.method === "DELETE") {
        res.on("finish", () => undefined);
        setTimeout(async () => {
          if (slot && observed.length === 0) {
            const row = await prisma.job.findUnique({ where: { id: slot.jobId }, select: { status: true } });
            observed.push(row?.status ?? "missing");
          }
          res.writeHead(204).end();
        }, 3000);
        return;
      }
      res.writeHead(200, { "Content-Type": "application/xml" }).end("<ok/>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    s3Port = typeof addr === "object" && addr ? addr.port : 0;
    process.env.STORAGE_DRIVER = "s3";
    process.env.S3_BUCKET = "p36-slow";
    process.env.S3_REGION = "us-east-1";
    process.env.S3_FORCE_PATH_STYLE = "true";
    process.env.S3_ENDPOINT = `http://127.0.0.1:${s3Port}`;
    process.env.S3_ACCESS_KEY_ID = "p36";
    process.env.S3_SECRET_ACCESS_KEY = "p36";
    const { _resetStorageForTests } = await import("../lib/storage");
    _resetStorageForTests();
  });

  afterAll(async () => {
    const { _resetStorageForTests } = await import("../lib/storage");
    _resetStorageForTests();
    for (const k of [
      "STORAGE_DRIVER",
      "S3_BUCKET",
      "S3_REGION",
      "S3_FORCE_PATH_STYLE",
      "S3_ENDPOINT",
      "S3_ACCESS_KEY_ID",
      "S3_SECRET_ACCESS_KEY",
    ]) {
      delete process.env[k];
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("commits the failure and the refund before reclaiming, under a 3s-per-delete bucket", async () => {
    const { createGenerationJob, failJob } = await import("../lib/queue");
    const user = await makeUser("slow-bucket", { credits: 100 });
    const { job } = await createGenerationJob({
      userId: user.id,
      model: "gpt",
      quality: "standard",
      count: 1,
      prompt: "a slow bucket",
    });
    // The claim is modelled directly rather than through claimNextJob: that
    // claims whatever is due anywhere in the database, and vitest runs the
    // other suites' jobs in parallel with this file. Two objects to reclaim:
    // the pre-auth's checkpoint plus a ref upload.
    await prisma.job.update({
      where: { id: job.id },
      data: {
        status: "running",
        worker: "p36-slow-worker",
        // A heartbeat in the future: this row is held for ~6 seconds while the
        // slow bucket answers, and the stale-job sweeps of the suites running
        // in parallel (theirs use cutoffs of a millisecond) must not reap it.
        heartbeatAt: new Date(Date.now() + 3600_000),
        refImageKey: "img/p36-ref.png",
        images: JSON.stringify([{ key: "img/p36-checkpoint.png", model: "gpt", quality: "standard" }]),
      },
    });
    slot = { jobId: job.id };
    observed.length = 0;

    const started = Date.now();
    await failJob(job.id, "provider 500", { terminal: true, worker: "p36-slow-worker" });
    const elapsed = Date.now() - started;

    // Two reclaim deletes at 3s each: the call is slow (the deletes are still
    // awaited), which is exactly what blew the 5s transaction before.
    expect(elapsed).toBeGreaterThanOrEqual(5000);

    const after = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.status).toBe("failed");
    expect(after.error).toContain("provider 500");
    // The refund landed: the account is whole again (pre-fix it stayed at the
    // spent balance, and the pre-auth grant stayed at remaining = 0).
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).credits).toBe(100);
    const grants = await prisma.creditGrant.findMany({ where: { userId: user.id } });
    expect(grants.reduce((s, g) => s + g.remaining, 0)).toBe(100);
    // ...and the terminal transition was already COMMITTED while the first
    // delete was in flight — the property that separates "cleanup after the
    // money" from "cleanup that can cancel it".
    expect(observed[0]).toBe("failed");
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 5. Queue: a zombie cannot requeue a peer's job, or plant its task id
// ---------------------------------------------------------------------------
describe("pass 36 — the failure and polling writers are fenced on the holder", () => {
  it("a non-holder's failJob leaves the live peer's row alone", async () => {
    const { createGenerationJob, failJob, extendPollLease } = await import("../lib/queue");
    const user = await makeUser("fence-fail", { credits: 100 });
    const { job } = await createGenerationJob({
      userId: user.id,
      model: "gpt",
      quality: "standard",
      count: 1,
      prompt: "fenced failure",
    });
    // W1 claimed the row, stalled past its lease, and W2 took it over — the
    // states are written directly (a global claim would pick up whichever job
    // is due anywhere in the parallel test database).
    await prisma.job.update({
      where: { id: job.id },
      data: {
        status: "running",
        worker: "w2-fence",
        startedAt: new Date(),
        // Future, so a parallel suite's stale sweep cannot reap this row while
        // the test is mid-assertion (see the slow-bucket fixture).
        heartbeatAt: new Date(Date.now() + 3600_000),
      },
    });

    // The zombie's failure report must not touch W2's claim. Pre-fix this
    // flipped the row to `queued` (burning an attempt), which also voided W2's
    // extendPollLease (polling-only) and let a third worker claim the job
    // inside W2's lease.
    await failJob(job.id, "download failed: 500", { worker: "w1-fence" });
    let row = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(row.status).toBe("running");
    expect(row.worker).toBe("w2-fence");
    expect(row.attempts).toBe(0);
    expect(row.error).toBeNull();

    // Positive control: the holder's own failure still transitions.
    await failJob(job.id, "download failed: 500", { worker: "w2-fence" });
    row = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(row.status).toBe("queued");
    expect(row.attempts).toBe(1);
    expect(row.error).toContain("download failed");
    // The holder's lease helper still works on a polling row (the zombie's
    // write above would have made it a no-op).
    await prisma.job.update({ where: { id: job.id }, data: { status: "polling" } });
    const before = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    await extendPollLease(job.id, "w2-fence");
    const after = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.nextAttemptAt!.getTime()).toBeGreaterThanOrEqual(before.nextAttemptAt!.getTime());
  });

  it("a non-holder's setJobPolling cannot plant its orphan task id", async () => {
    const { createMediaJob, setJobPolling } = await import("../lib/queue");
    const user = await makeUser("fence-poll", { credits: 500 });
    const { job } = await createMediaJob({
      userId: user.id,
      model: "seedance",
      mediaType: "video",
      quality: "standard",
      count: 1,
      prompt: "fenced polling",
      durationSec: 5,
    });
    // W1 held it ("running"), then W2 took the row over after W1 stalled past
    // its lease.
    await prisma.job.update({
      where: { id: job.id },
      data: { status: "running", worker: "w2-poll", heartbeatAt: new Date(Date.now() + 3600_000) },
    });

    // Pre-fix W1's late write was ACCEPTED (the CAS only asked for
    // running/queued), so the row named W1's task forever and W2's own task —
    // already created and billed upstream — was uncollectable.
    expect(await setJobPolling(job.id, "task-from-zombie", "w1-poll")).toBe(false);
    const row = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(row.providerTaskId).toBeNull();
    expect(row.status).toBe("running");

    // Positive control: the holder records its own task.
    expect(await setJobPolling(job.id, "task-from-holder", "w2-poll")).toBe(true);
    expect(
      (await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).providerTaskId,
    ).toBe("task-from-holder");
  });
});

// ---------------------------------------------------------------------------
// 6. Queue: the reaper reaps every stuck job, and the worker id is per-boot
// ---------------------------------------------------------------------------
describe("pass 36 — the recovery sweep survives a row that throws, and worker ids are unique per boot", () => {
  it("a stuck row whose failure throws does not stop the sweep", async () => {
    const { createGenerationJob, recoverStuckJobs } = await import("../lib/queue");
    const userA = await makeUser("reap-a", { credits: 100 });
    const userB = await makeUser("reap-b", { credits: 100 });
    const mk = async (userId: string, tag: string) => {
      const { job } = await createGenerationJob({
        userId,
        model: "gpt",
        quality: "standard",
        count: 1,
        prompt: tag,
      });
      await prisma.job.update({
        where: { id: job.id },
        data: {
          status: "running",
          worker: `p36-reap-${tag}`,
          // Ten days old, and the sweep below only looks at rows older than
          // nine: recoverStuckJobs' batch is global (ORDER BY id LIMIT 20) and
          // the other suites run in parallel with this file, so the window is
          // what keeps this test about its own two rows.
          startedAt: new Date(Date.now() - 10 * 24 * 3600_000),
          heartbeatAt: new Date(Date.now() - 10 * 24 * 3600_000),
          // One attempt, so the sweep's failure is TERMINAL (and refunds):
          // a row with attempts left is requeued instead, which is the retry
          // transition and not what this test is about.
          maxAttempts: 1,
        },
      });
      return job.id;
    };
    const first = await mk(userA.id, "a");
    const second = await mk(userB.id, "b");
    // The batch is ORDER BY id, so the row whose failure is injected below is
    // processed before the control row.
    expect(first < second).toBe(true);

    // The shape the storage reclaim used to produce on every tick, injected at
    // the boundary instead: ONE row's failJob throws. Pre-fix the throw
    // propagated out of the sweep (it is a bare `for … await failJob`), so every
    // later stuck job was never reaped — that customer's pre-auth stayed held
    // and an inflight slot stayed occupied — and the batch, re-selected ORDER BY
    // id, retried the same row first forever.
    const NINE_DAYS = 9 * 24 * 3600_000;
    // vi.spyOn(...).mockRestore() leaves $transaction UNDEFINED on this
    // client (it is an own data property on a Proxy-based object — measured),
    // so the original value is put back by hand.
    const originalTx = prisma.$transaction.bind(prisma);
    // mockImplementation, not mockRejectedValueOnce: a spy with only a "once"
    // value is a MOCK — every later call would return undefined instead of
    // running the transaction, so nothing after the injected failure would
    // transition at all (measured).
    let rejectNext = true;
    vi.spyOn(prisma, "$transaction").mockImplementation(((
      ...args: unknown[]
    ) => {
      if (rejectNext) {
        rejectNext = false;
        return Promise.reject(new Error("p36-injected-transaction-failure"));
      }
      return (originalTx as (...a: unknown[]) => unknown)(...args);
    }) as never);
    let recovered: number | null = null;
    let thrown: unknown = null;
    try {
      recovered = await recoverStuckJobs(NINE_DAYS, NINE_DAYS);
    } catch (e) {
      thrown = e;
    } finally {
      (prisma as unknown as { $transaction: unknown }).$transaction = originalTx;
    }

    expect(thrown).toBeNull();
    expect(recovered).not.toBeNull();
    // The row AFTER the throwing one was reaped: terminal, refunded, and its
    // account is whole. Pre-fix this row was never touched.
    const secondRow = await prisma.job.findUniqueOrThrow({ where: { id: second } });
    expect(secondRow.status).toBe("failed");
    expect(secondRow.error).toMatch(/stuck-timeout/);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: userB.id } })).credits).toBe(100);
    // The row whose failure threw is not lost: the next tick, with nothing
    // injected, takes it (a sweep is a sweep, not a transaction).
    const again = await recoverStuckJobs(NINE_DAYS, NINE_DAYS);
    expect(again).toBeGreaterThanOrEqual(0);
    expect((await prisma.job.findUniqueOrThrow({ where: { id: first } })).status).toBe("failed");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: userA.id } })).credits).toBe(100);
  }, 30_000);

  it("the worker's id is unique per boot, not per pid slot", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "scripts", "worker.ts"), "utf8");
    // `worker-${process.pid}` looked unique and is not: under `--scale worker=3`
    // (the documented deployment) every replica has its own pid NAMESPACE, so
    // the node process lands on the same pid in all three. Probed with the
    // shipped image: 12 boots produced two distinct ids, i.e. three replicas
    // always share at least two. The id is the only thing the fencing above
    // compares, so a collision voids it for that pair.
    expect(src).toMatch(/const workerId = `worker-\$\{hostname\(\)\}-\$\{process\.pid\}-\$\{randomUUID\(\)\.slice\(0, 8\)\}`;/);
    expect(src).toContain('from "node:os"');
    expect(src).toContain('from "node:crypto"');
  });
});

// ---------------------------------------------------------------------------
// 7. HTTP: a revoked cookie cannot re-date itself
// ---------------------------------------------------------------------------
describe("pass 36 — the session read path re-checks revocation", () => {
  it("strips the identity off a token whose sessionVersion was bumped", async () => {
    const { authOptions } = await import("../lib/auth");
    const user = await makeUser("jwt-read", { credits: 10 });
    // Bump the version the way revoke-sessions / a password reset does.
    await prisma.user.update({ where: { id: user.id }, data: { sessionVersion: { increment: 1 } } });

    const stale = { uid: user.id, sv: user.sessionVersion, totpPending: false, email: user.email, name: "P36", sub: user.id };
    const returned = await authOptions.callbacks!.jwt!({
      token: { ...stale },
      user: undefined,
      account: null,
    } as never);
    // Pre-fix the callback returned the token untouched on every read, and
    // next-auth re-encodes whatever it returns with a FRESH 30-day expiry: the
    // cookie was a self-renewing credential that /api/auth/session answered
    // with the account's identity while every guarded route 401'd.
    expect((returned as { uid?: string }).uid).toBeUndefined();
    expect((returned as { sv?: number }).sv).toBeUndefined();
    expect((returned as { email?: string }).email).toBeUndefined();
    expect((returned as { sub?: string }).sub).toBeUndefined();

    // The session callback reports no user for such a token, so the session
    // route cannot echo the identity it decoded either.
    const session = { user: { name: "P36", email: user.email }, expires: "x" };
    const out = await authOptions.callbacks!.session!({
      session: session as never,
      token: returned as never,
      user: undefined as never,
    } as never);
    expect((out as { user?: unknown }).user).toBeUndefined();

    // Positive control: a live token keeps its identity, and a token with no
    // numeric sv (legacy, unverifiable) is stripped too — fail closed.
    const live = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { sessionVersion: true } });
    const kept = await authOptions.callbacks!.jwt!({
      token: { uid: user.id, sv: live.sessionVersion, totpPending: false },
      user: undefined,
      account: null,
    } as never);
    expect((kept as { uid?: string }).uid).toBe(user.id);
    const noSv = await authOptions.callbacks!.jwt!({
      token: { uid: user.id, totpPending: false },
      user: undefined,
      account: null,
    } as never);
    expect((noSv as { uid?: string }).uid).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 8. HTTP: the page ceiling cannot be refreshed by rotating the cookie
// ---------------------------------------------------------------------------
describe("pass 36 — the middleware bucket is keyed by account AND session version", () => {
  const SECRET = process.env.NEXTAUTH_SECRET ?? "p36-proxy-secret-not-for-production-use";
  const saved = { page: process.env.MIDDLEWARE_PAGE_LIMIT, secret: process.env.NEXTAUTH_SECRET };

  beforeAll(() => {
    process.env.NEXTAUTH_SECRET = SECRET;
    process.env.MIDDLEWARE_PAGE_LIMIT = "2";
  });
  afterAll(() => {
    if (saved.page === undefined) delete process.env.MIDDLEWARE_PAGE_LIMIT;
    else process.env.MIDDLEWARE_PAGE_LIMIT = saved.page;
    process.env.NEXTAUTH_SECRET = SECRET;
  });

  it("a re-minted cookie value does not buy a fresh page budget", async () => {
    const { NextRequest } = await import("next/server");
    const { proxy } = await import("../proxy");
    const user = await makeUser("page-bucket");
    // A live session at version 1, so "stale" (version 0) is really different.
    const liveSv = (
      await prisma.user.update({
        where: { id: user.id },
        data: { sessionVersion: { increment: 1 } },
        select: { sessionVersion: true },
      })
    ).sessionVersion;
    const req = (cookie: string, ip = "203.0.113.240") =>
      new NextRequest(new URL("http://localhost:3100/studio"), {
        headers: { "x-forwarded-for": `10.0.0.1, ${ip}`, cookie },
      });

    const c1 = await encode({ token: { uid: user.id, sv: liveSv }, secret: SECRET });
    const c2 = await encode({ token: { uid: user.id, sv: liveSv }, secret: SECRET });
    // Three requests fill the budget, then the ceiling holds.
    expect((await proxy(req(`next-auth.session-token=${c1}`))).status).toBe(200);
    expect((await proxy(req(`next-auth.session-token=${c1}`))).status).toBe(200);
    expect((await proxy(req(`next-auth.session-token=${c1}`))).status).toBe(429);
    // Pre-fix the bucket came from the CIPHERTEXT hash, and next-auth re-mints
    // the cookie for free on every /api/auth/session call: one rotation every
    // second bought a fresh 120/min — 40×120 per address — and the pass-34 page
    // ceiling capped nothing (the page shells have no per-route limiter). Now
    // the key is `u:<id>:<sv>`, which the re-mint preserves.
    expect((await proxy(req(`next-auth.session-token=${c2}`))).status).toBe(429);

    // A stale (revoked) cookie is still a different bucket — the pass-31
    // property: it can neither spend the live session's budget nor be denied by
    // it.
    const stale = await encode({ token: { uid: user.id, sv: liveSv - 1 }, secret: SECRET });
    expect((await proxy(req(`next-auth.session-token=${stale}`))).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 9. Ops: the helpers that failed open
// ---------------------------------------------------------------------------
describe("pass 36 — a credential-shaped URL segment is masked unless it is a known endpoint word", () => {
  it("masks the shapes the token-pattern test let through", async () => {
    const { maskSecretUrl } = await import("../lib/mail-check");
    // decodeURIComponent throws on a stray '%' → the old helper fell back to
    // the RAW segment, which the token pattern then rejected (the class has no
    // '%'): the full 36-char Feishu token was echoed into the terminal/CI
    // log/ticket the masking exists for.
    const pct = maskSecretUrl("https://open.feishu.cn/open-apis/bot/v2/hook/6d5f2c1a%zz9e3b4c7d8f10aa11bb22cc33");
    expect(pct).not.toContain("6d5f2c1a");
    expect(pct).not.toContain("%zz");
    // A validly percent-encoded segment decodes to something with a '/' — also
    // outside the old class, also echoed in full.
    const enc = maskSecretUrl("https://open.feishu.cn/open-apis/bot/v2/hook/abc%2Fdef0123456789abcdef012345");
    expect(enc).not.toContain("def0123456789abcdef");
    // ...and a plain token still masks, with the endpoint shape visible.
    expect(maskSecretUrl("https://open.feishu.cn/open-apis/bot/v2/hook/0f1e2d3c-4a5b-6c7d-8e9f-001122334455")).toBe(
      "https://open.feishu.cn/open-apis/bot/v2/hook/…(36 chars)",
    );
    // A path this list does not know masks instead of echoing (fail closed).
    const custom = maskSecretUrl("https://example.com/mycompany/webhook/AbC123DEF456");
    expect(custom).not.toContain("AbC123DEF456");
    expect(custom).not.toContain("mycompany");
  });
});

describe("pass 36 — the audit refuses a payload that is not a raster image", () => {
  it("declares no type for bytes the sniffer does not recognize", async () => {
    const { auditPayloadExt } = await import("../lib/safety");
    const { sniffContentType } = await import("../lib/media-type");
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"></svg>');
    const html = Buffer.from("<!doctype html><p>hi</p>");
    // These are the bytes that used to be announced to the moderation gateway
    // as `image/png` (the ext fallback), below the 1 MiB downscale threshold
    // where the raster guard did not run at all.
    expect(sniffContentType(svg)).toBeNull();
    expect(auditPayloadExt(null)).toBeNull();
    expect(auditPayloadExt(sniffContentType(svg))).toBeNull();
    expect(auditPayloadExt(sniffContentType(html))).toBeNull();
    // Controls: the three raster formats keep their true subtype.
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]);
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(8)]);
    const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(4)]);
    expect(auditPayloadExt(sniffContentType(png))).toBe("png");
    expect(auditPayloadExt(sniffContentType(jpeg))).toBe("jpeg");
    expect(auditPayloadExt(sniffContentType(webp))).toBe("webp");
    // A small non-raster payload is refused by the same guard the oversized
    // path has always had (shrinkForAudit), i.e. both sides of the size branch
    // now agree about what may be audited.
    const { shrinkForAudit } = await import("../lib/safety");
    await expect(shrinkForAudit(svg)).rejects.toThrow(/unsupported-image-format/);
  });
});

describe("pass 36 — the invisible-character strip covers the whole Cf class", () => {
  it("blocks the evasions the enumerated list missed, and keeps visible text", async () => {
    const { stripFormatControls, checkPrompt } = await import("../lib/safety");
    // U+180E MONGOLIAN VOWEL SEPARATOR, U+061C ARABIC LETTER MARK, the TAG
    // block, U+FFF9 INTERLINEAR ANNOTATION ANCHOR, and a variation-selector
    // pair: all invisible, none of them in the pass-34 enumeration, all of them
    // walking a word past `\bnude\b` (probed).
    const evasions = ["nud\u180ee", "s\u061Cex", "nud\u{E007F}e", "nud\uFFF9e", "nu\u{FE0F}de"];
    for (const e of evasions) {
      expect(stripFormatControls(e), JSON.stringify(e)).not.toContain("\u180e");
      expect(checkPrompt(`a photo of ${e} woman`).ok, JSON.stringify(e)).toBe(false);
    }
    // Visible characters are NOT stripped: a non-breaking space, an ideographic
    // space, a combining mark and CJK all survive, so prose and non-Latin
    // scripts are unchanged by the property class.
    for (const keep of ["a\u00a0b", "x\u3000y", "cafe\u0301", "中文 テスト"]) {
      expect(stripFormatControls(keep)).toBe(keep);
    }
  });
});

describe("pass 36 — .env.example states the tracing default the code actually uses", () => {
  it("carries the same rate every Sentry config falls back to", () => {
    const root = path.join(__dirname, "..");
    const example = fs.readFileSync(path.join(root, ".env.example"), "utf8");
    const line = example.split("\n").find((l) => l.startsWith("SENTRY_TRACES_SAMPLE_RATE="));
    expect(line, "SENTRY_TRACES_SAMPLE_RATE must be documented").toBeTruthy();
    const value = (line as string).split("=")[1].replaceAll('"', "");
    // The file used to say "unset = no performance tracing" while every runtime
    // defaulted an empty value to 0.1 — a stack that copied it shipped 10% of
    // its transactions to Sentry while its own config said otherwise.
    for (const file of [
      "lib/observability.ts",
      "sentry.server.config.ts",
      "sentry.edge.config.ts",
      "instrumentation-client.ts",
    ]) {
      const src = fs.readFileSync(path.join(root, file), "utf8");
      const m = src.match(/TRACES_SAMPLE_RATE[^,]*,\s*([0-9.]+)/);
      expect(m, `${file} must fall back to a literal`).toBeTruthy();
      expect(m![1], file).toBe(value);
    }
  });
});
