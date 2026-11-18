import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createHmac } from "crypto";
import { execFileSync } from "child_process";
import { NextRequest } from "next/server";
import Redis from "ioredis";
import { prisma } from "../lib/prisma";

// Pass 34. The findings from four parallel domain audits over 8475aa4, each
// with the case that reproduces it:
//
//   - P3 money: the Paddle paid-event parser read the transaction's totals from
//     the TOP level, but a Paddle Transaction carries them under `details` (the
//     Adjustment entity is the one that puts them at the top). paidAmountUsd was
//     therefore always undefined and the route's amount leg — the one leg that
//     binds money to the order — never ran for Paddle: a signed $1
//     transaction.completed naming the $49.99 order fulfilled it in full.
//   - P4 worker: schedulePoll/heartbeat wrote nextAttemptAt/heartbeatAt blind to
//     the worker holding the row, so a zombie's late re-arm truncated the new
//     holder's poll lease and let a third worker into phase 2.
//   - P4 money: a signed Paddle REVERSAL on an already-refunded order was a
//     silent no-op — money back with the merchant, customer still revoked,
//     nobody told.
//   - P4 auth: the 2FA failure counter was the one place doing INCR and EXPIRE
//     as two commands; a lost EXPIRE left a TTL-less counter (permanent
//     lockout) reporting "retry in 1 second".
//   - P4 auth: the published-CI-secret boot gate compared raw bytes, so the
//     public value with one stray whitespace character booted.
//   - P3 auth: the edge limiter's matcher covered /api/* only, so the
//     authenticated page shells (session read + SSR on every request) were
//     charged to no bucket at all.
//   - P4 http: the prompt word list fell to zero-width and non-\s separators
//     (they are not JS whitespace, so neither the collapse nor \b matched).
//   - P4 http: two prompt schemas accepted a whitespace-only prompt — a billed
//     provider call for no user content.
//   - P4 http: 24 routes answered an oversized body with a hand-rolled 413
//     (text/plain, no no-store) and /api/health's exception path was the one
//     response without Cache-Control.
//   - P3 ops: ./backups is gitignored, so a fresh clone has no such directory
//     and Docker creates it root-owned; the backup loops then failed every
//     night while both services showed Up, and the chmod that would have said
//     so had its stderr discarded.
//   - P4 ops: the image gates asserted a subset of the globs the prune lists
//     carry (PRODUCT_OUTLINE.md, .env.example, two compose files), the prod
//     compose pinned S3_FORCE_PATH_STYLE instead of forwarding it, the dev
//     compose's migrate service had no image pin, ci-local's leak gate needed
//     material no fresh checkout has, and release.md told the operator to run
//     a repo-tree npx command the documented host cannot run.

const REPO = path.resolve(__dirname, "..");
const stamp = Date.now();
let seq = 0;

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO, rel), "utf8");
}

// Route handlers are driven directly; next-auth's session helper is stubbed to
// "signed out" exactly as tests/pass33-hardening.test.ts does (the real one
// reaches for next/headers' cookies(), which has no request store under vitest).
vi.mock("next-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-auth")>();
  return {
    ...actual,
    default: () => vi.fn(async () => new Response("{}", { status: 200 })),
    getServerSession: async () => null,
  };
});

const { POST: webhookPOST } = await import("../app/api/webhooks/payment/route");
const { POST: v1POST } = await import("../app/api/v1/images/generations/route");
const { POST: feedbackPOST } = await import("../app/api/feedback/route");

async function makeUser(tag: string, extra: Record<string, unknown> = {}) {
  return prisma.user.create({
    data: {
      email: `p34-${tag}-${stamp}-${seq++}@test.dev`,
      passwordHash: "x",
      emailVerified: new Date(),
      ...extra,
    },
  });
}

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
let redis: Redis | null = null;
beforeAll(async () => {
  const c = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 0 });
  try {
    await c.connect();
    await c.ping();
    redis = c;
  } catch {
    redis = null;
    await c.quit().catch(() => undefined);
  }
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { contains: "p34-" } } });
  await prisma.order.deleteMany({ where: { idempotencyKey: { contains: "p34-" } } });
  await prisma.apiKey.deleteMany({ where: { name: { contains: "p34-" } } });
  await redis?.quit().catch(() => undefined);
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// 1. A Paddle transaction's amount binds to the order it names
// ---------------------------------------------------------------------------
const PADDLE_SECRET = "pdl_whsec_p34_test";

function paddleSign(payload: string, ts = Math.floor(Date.now() / 1000)): string {
  const h1 = createHmac("sha256", PADDLE_SECRET).update(`${ts}:${payload}`).digest("hex");
  return `ts=${ts};h1=${h1}`;
}

function paddleBody(eventType: string, eventId: string, data: Record<string, unknown>): string {
  return JSON.stringify({ event_id: eventId, event_type: eventType, occurred_at: new Date().toISOString(), data });
}

function paddleRequest(payload: string): Request {
  return new Request("http://localhost/api/webhooks/payment", {
    method: "POST",
    headers: { "content-type": "application/json", "paddle-signature": paddleSign(payload) },
    body: payload,
  });
}

function adjustmentData(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "adj_p34_1",
    action: "refund",
    status: "approved",
    transaction_id: "txn_p34_rev",
    customer_id: "ctm_1",
    reason: "customer requested",
    credit_applied_to_balance: false,
    currency_code: "USD",
    items: [],
    totals: { subtotal: "4999", tax: "0", total: "4999", fee: "0", earnings: "0", currency_code: "USD", retained_fee: "0" },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("pass 34 — the Paddle paid event carries the amount the order guard reads", () => {
  const savedEnv = {
    provider: process.env.PAYMENT_PROVIDER,
    key: process.env.PADDLE_API_KEY,
    secret: process.env.PADDLE_WEBHOOK_SECRET,
    environment: process.env.PADDLE_ENVIRONMENT,
  };

  beforeAll(async () => {
    process.env.PAYMENT_PROVIDER = "paddle";
    process.env.PADDLE_API_KEY = "pdl_sdbx_p34_dummy";
    process.env.PADDLE_WEBHOOK_SECRET = PADDLE_SECRET;
    process.env.PADDLE_ENVIRONMENT = "sandbox";
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
      ["PADDLE_ENVIRONMENT", savedEnv.environment],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("parses the totals where a Transaction actually carries them (data.details.totals)", async () => {
    // Pre-fix: `data.totals` — a field ITransactionResponse and
    // ITransactionNotificationResponse do not have — so paidAmountUsd was
    // undefined for every real Paddle delivery and the route's amount leg was
    // dead code (assertPaymentMatchesOrder skips a missing amount).
    const { PaddleProvider } = await import("../lib/payments/paddle");
    const { Paddle, Environment } = await import("@paddle/paddle-node-sdk");
    const p = new PaddleProvider({
      client: new Paddle("pdl_sdbx_p34_dummy", { environment: Environment.sandbox }),
      webhookSecret: PADDLE_SECRET,
    });
    const payload = paddleBody("transaction.completed", `evt_p34_parse_${stamp}`, {
      id: "txn_p34_parse",
      status: "completed",
      custom_data: { orderId: "order_p34_parse" },
      currency_code: "USD",
      collection_mode: "automatic",
      items: [],
      payments: [],
      // The real wire shape. The old parser looked one level up.
      details: { totals: { subtotal: "100", tax: "0", total: "100", currency_code: "USD" } },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    const evt = await p.verifyWebhook(payload, new Headers({ "paddle-signature": paddleSign(payload) }));
    expect(evt && !("ignored" in evt)).toBe(true);
    const paid = evt as { type: string; paidAmountUsd?: number };
    expect(paid.type).toBe("paid");
    expect(paid.paidAmountUsd).toBe(1);
  });

  it("refuses an underpaid transaction naming a more expensive order, end to end", async () => {
    // The exploit the dead leg allowed: a signed $1 transaction whose
    // custom_data names the $49.99 pending order. Pre-fix the route answered
    // 200, flipped the order to paid and granted the 6000 credits.
    const user = await makeUser("underpaid", { credits: 0 });
    const order = await prisma.order.create({
      data: {
        userId: user.id,
        kind: "pack",
        status: "pending",
        amountUsd: 49.99,
        credits: 6000,
        provider: "paddle",
        providerOrderId: "txn_p34_under",
        idempotencyKey: `p34-under-${stamp}-${seq++}`,
      },
    });
    const payload = paddleBody("transaction.completed", `evt_p34_under_${stamp}`, {
      id: "txn_p34_other",
      status: "completed",
      custom_data: { orderId: order.id },
      currency_code: "USD",
      collection_mode: "automatic",
      items: [],
      payments: [],
      details: { totals: { subtotal: "100", tax: "0", total: "100", currency_code: "USD" } },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    const res = await webhookPOST(paddleRequest(payload));
    expect(res.status).toBe(500); // recorded, refused, retried — never fulfilled
    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe("pending");
    const grants = await prisma.creditGrant.count({ where: { refId: order.id } });
    expect(grants).toBe(0);

    // Positive control: the same order, paid in full, fulfils.
    const good = paddleBody("transaction.completed", `evt_p34_good_${stamp}`, {
      id: "txn_p34_under",
      status: "completed",
      custom_data: { orderId: order.id },
      currency_code: "USD",
      collection_mode: "automatic",
      items: [],
      payments: [],
      details: { totals: { subtotal: "4999", tax: "0", total: "4999", currency_code: "USD" } },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    const okRes = await webhookPOST(paddleRequest(good));
    expect(okRes.status).toBe(200);
    const paidNow = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(paidNow.status).toBe("paid");
    expect(await prisma.creditGrant.count({ where: { refId: order.id } })).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2. A reversal on an already-refunded order is surfaced
// ---------------------------------------------------------------------------
describe("pass 34 — a reversal of revoked money reaches the operator", () => {
  const savedEnv = {
    provider: process.env.PAYMENT_PROVIDER,
    key: process.env.PADDLE_API_KEY,
    secret: process.env.PADDLE_WEBHOOK_SECRET,
  };

  beforeAll(async () => {
    process.env.PAYMENT_PROVIDER = "paddle";
    process.env.PADDLE_API_KEY = "pdl_sdbx_p34_dummy";
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

  it("reports the funds-returned state instead of a silent no-op", async () => {
    // Sequence: paid → full refund (credits + tier revoked, customer mailed) →
    // the dispute is reversed in the merchant's favour. Pre-fix the reversal
    // subtracted from the accumulator, matched no CAS arm on a `refunded` row,
    // was ACKed, and nothing anywhere said the customer holds nothing for money
    // the merchant kept — PaymentEvent has no admin read path.
    const user = await makeUser("reversed", { credits: 6000 });
    const order = await prisma.order.create({
      data: {
        userId: user.id,
        kind: "pack",
        status: "paid",
        amountUsd: 49.99,
        credits: 6000,
        provider: "paddle",
        providerOrderId: "txn_p34_rev",
        idempotencyKey: `p34-rev-${stamp}-${seq++}`,
      },
    });
    await prisma.creditGrant.create({
      data: { userId: user.id, source: "PURCHASE", amount: 6000, remaining: 6000, refType: "order", refId: order.id },
    });

    const refund = await webhookPOST(
      paddleRequest(paddleBody("adjustment.created", `evt_p34_ref_${stamp}`, adjustmentData({ type: "full" }))),
    );
    expect(refund.status).toBe(200);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("refunded");
    expect(await prisma.creditGrant.count({ where: { refId: order.id, remaining: { gt: 0 } } })).toBe(0);

    // The reversal arrives as adjustment.updated on the same adjustment.
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map((a) => String(a)).join(" "));
    });
    let res: Response;
    try {
      res = await webhookPOST(
        paddleRequest(
          paddleBody("adjustment.updated", `evt_p34_rev_${stamp}`, adjustmentData({ status: "reversed" })),
        ),
      );
    } finally {
      spy.mockRestore();
    }
    expect(res.status).toBe(200); // persisted + acked; no retry will look again
    expect(errors.join("\n")).toContain("refund-reversed");
    // The policy is unchanged: nothing un-revokes automatically.
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("refunded");
  });
});

// ---------------------------------------------------------------------------
// 3. The zombie worker cannot re-arm or heartbeat a peer's lease
// ---------------------------------------------------------------------------
describe("pass 34 — schedulePoll and heartbeat are conditioned on the holding worker", () => {
  let pollIntervalMs = 0;
  let leaseMs = 0;

  it("a non-holder's schedulePoll leaves the holder's lease alone", async () => {
    const { createMediaJob, claimNextJob, schedulePoll, heartbeat, POLL_INTERVAL_MS, POLL_LEASE_MS } =
      await import("../lib/queue");
    pollIntervalMs = POLL_INTERVAL_MS;
    leaseMs = POLL_LEASE_MS;
    const user = await makeUser("lease", { credits: 100 });
    await prisma.creditGrant.create({
      data: { userId: user.id, source: "PURCHASE", amount: 100, remaining: 100, refType: "order", refId: `p34-lease-${stamp}` },
    });
    const { job } = await createMediaJob({
      userId: user.id,
      model: "seedance",
      mediaType: "video",
      quality: "standard",
      count: 1,
      prompt: "lease probe",
      durationSec: 5,
    });

    // Park every other queued/polling job this shared database holds, so the
    // claim below can only be this job (tests/queue-video.test.ts's helper).
    async function parkOthers(excludeId: string) {
      const others = await prisma.job.findMany({
        where: { status: { in: ["queued", "polling"] }, id: { not: excludeId } },
        select: { id: true, nextAttemptAt: true },
      });
      if (others.length) {
        await prisma.job.updateMany({
          where: { id: { in: others.map((o) => o.id) } },
          data: { nextAttemptAt: new Date(Date.now() + 3_600_000) },
        });
      }
      return others;
    }
    async function unpark(others: Array<{ id: string; nextAttemptAt: Date | null }>) {
      for (const o of others) {
        await prisma.job.update({ where: { id: o.id }, data: { nextAttemptAt: o.nextAttemptAt } });
      }
    }

    let parked = await parkOthers(job.id);
    const first = await claimNextJob("w1");
    await unpark(parked);
    expect(first?.id).toBe(job.id);
    expect(first?.worker).toBe("w1");

    // Phase 1 created the provider task and armed the first poll; W1 stalls
    // past its lease, and W2 claims the POLL slot (lane 2 needs 'polling';
    // nextAttemptAt forced into the past stands in for the expiry).
    const { setJobPolling } = await import("../lib/queue");
    await setJobPolling(job.id, "task-p34-lease", "w1");
    await prisma.job.update({ where: { id: job.id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
    parked = await parkOthers(job.id);
    const second = await claimNextJob("w2");
    await unpark(parked);
    expect(second?.worker).toBe("w2");
    const heldLease = second!.nextAttemptAt!.getTime();

    // The zombie wakes and finishes one more poll: pre-fix this rewound
    // nextAttemptAt to +10s and let a third worker claim inside W2's lease.
    await schedulePoll(job.id, "w1");
    const afterZombie = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(afterZombie.worker).toBe("w2");
    expect(afterZombie.nextAttemptAt!.getTime()).toBe(heldLease);

    // The holder's own re-arm still works (positive control).
    await schedulePoll(job.id, "w2");
    const afterHolder = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(afterHolder.nextAttemptAt!.getTime()).toBeLessThanOrEqual(Date.now() + pollIntervalMs + 2000);
    expect(leaseMs).toBeGreaterThan(pollIntervalMs);

    // heartbeat: the zombie must not keep a peer's job looking alive.
    const stampBefore = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    await new Promise((r) => setTimeout(r, 20));
    await heartbeat(job.id, "w1");
    const afterHb = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(afterHb.heartbeatAt!.getTime()).toBe(stampBefore.heartbeatAt!.getTime());
    await heartbeat(job.id, "w2");
    const afterHb2 = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(afterHb2.heartbeatAt!.getTime()).toBeGreaterThan(stampBefore.heartbeatAt!.getTime());

    await prisma.job.update({ where: { id: job.id }, data: { status: "failed" } });
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 4. The 2FA counter cannot outlive its window
// ---------------------------------------------------------------------------
describe("pass 34 — the 2FA failure counter is incremented and expired atomically", () => {
  it("issues one script (INCR + EXPIRE), and the script sets the TTL on creation", async () => {
    const src = read("lib/twofa.ts");
    const script = src.match(/const FAIL_BUMP_SCRIPT = `([\s\S]*?)`;/);
    expect(script, "the increment and the expiry must be ONE script").toBeTruthy();
    expect(script![1]).toMatch(/INCR/);
    expect(script![1]).toMatch(/EXPIRE/);
    // The two-command shape is gone: no bare INCR followed by a separate EXPIRE.
    const fn = src.slice(src.indexOf("export async function recordTwoFactorFailure"));
    expect(fn.slice(0, 900)).not.toMatch(/c\.incr\(/);
    expect(fn.slice(0, 900)).not.toMatch(/c\.expire\(/);
    // The script's own semantics, against the real Redis: the first increment
    // leaves a TTL behind, which is the property the lost-EXPIRE case lacked.
    if (redis) {
      const key = `2fa:fail:p34-script-${stamp}`;
      await redis.del(key);
      const n = (await redis.eval(script![1], 1, key, 86400)) as number;
      expect(n).toBe(1);
      const ttl = await redis.ttl(key);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(86400);
      await redis.del(key);
    }
  });

  it("the shipped function leaves an expiring counter (control)", async () => {
    if (!redis) return; // REDIS_URL unset: the process-local mirror path, covered elsewhere
    const { recordTwoFactorFailure } = await import("../lib/twofa");
    const id = `p34-user-${stamp}`;
    await redis.del(`2fa:fail:${id}`);
    await recordTwoFactorFailure(id);
    expect(await redis.ttl(`2fa:fail:${id}`)).toBeGreaterThan(0);
    await redis.del(`2fa:fail:${id}`);
  });
});

// ---------------------------------------------------------------------------
// 5. The published CI secret is rejected modulo whitespace and case
// ---------------------------------------------------------------------------
describe("pass 34 — the published-secret gate normalises before comparing", () => {
  const PUBLISHED = "5c1f8e2a94b7d03f6ae4c81d2795bf30e6a1c47d8b92f650";

  function productionEnv(secret: string): NodeJS.ProcessEnv {
    return {
      NODE_ENV: "production",
      NEXTAUTH_SECRET: secret,
      NEXTAUTH_URL: "https://pixelduo.example",
      SMTP_URL: "smtps://user:pass@smtp.example:465",
    } as NodeJS.ProcessEnv;
  }

  it("refuses the value with a trailing newline or space, and in any case", async () => {
    const { assertProductionConfig } = await import("../instrumentation");
    // Pre-fix: `secret === PUBLISHED_CI_SECRET` compared raw bytes, so the
    // public value plus one whitespace character booted — and the signing key
    // is then public modulo whitespace, i.e. forgeable by any repo reader.
    expect(() => assertProductionConfig(productionEnv(`${PUBLISHED}\n`))).toThrow(/published/i);
    expect(() => assertProductionConfig(productionEnv(`${PUBLISHED} `))).toThrow(/published/i);
    expect(() => assertProductionConfig(productionEnv(PUBLISHED.toUpperCase()))).toThrow(/published/i);
    expect(() => assertProductionConfig(productionEnv(` ${PUBLISHED}`))).toThrow(/published/i);
    // Controls: a real secret boots, and the CI runtime may still use the
    // published one (testDeployment escape hatch).
    expect(() =>
      assertProductionConfig(productionEnv("Zq7pR2vX9mK4tL8wN3cB6hJ1yF5dG0aS7eU2iO4kM9nP")),
    ).not.toThrow();
    // The CI runtime is a LOOPBACK test deployment (pass 63): the mock flag
    // alone does not exempt a public origin from the published-key refusal.
    const ciEnv = productionEnv(PUBLISHED);
    ciEnv.PAYMENT_ALLOW_MOCK = "1";
    expect(() => assertProductionConfig(ciEnv)).toThrow(/published/i);
    ciEnv.NEXTAUTH_URL = "http://localhost:3100";
    expect(() => assertProductionConfig(ciEnv)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 6. The prompt word list survives zero-width separators
// ---------------------------------------------------------------------------
describe("pass 34 — the prompt list cannot be spelled out of reach", () => {
  it("collapses zero-width and non-\\s separators, and strips the formats", async () => {
    const { checkPrompt, collapseLetterSpacing, stripFormatControls } = await import("../lib/safety");
    // Pre-fix: Cf characters are not \s in JS, so `n\u200bu\u200bd\u200be`
    // neither collapsed nor matched \bnude\b — and the same for nudi\u200bty,
    // where no collapse was needed at all. Commas/slashes were outside the
    // five-character separator list for the same reason.
    expect(checkPrompt("n\u200bu\u200bd\u200be woman, photorealistic").ok).toBe(false);
    expect(checkPrompt("nudi\u200bty photos").ok).toBe(false);
    expect(checkPrompt("n,u,d,e woman").ok).toBe(false);
    expect(checkPrompt("n/u/d/e").ok).toBe(false);
    expect(checkPrompt("色\u200b情图片").ok).toBe(false);
    expect(checkPrompt("g\u2060ore scene").ok).toBe(false);
    expect(stripFormatControls("a\u200db\ufeffc")).toBe("abc");
    expect(collapseLetterSpacing("n\u200bu\u200bd\u200be woman")).toContain("nude");
    // Controls from pass 25 / tests/safety.test.ts must still pass.
    expect(checkPrompt("a serene lake at dawn").ok).toBe(true);
    expect(checkPrompt("Essex county landscape").ok).toBe(true);
    expect(checkPrompt("a big cat in a field").ok).toBe(true);
    expect(collapseLetterSpacing("a big cat in a field")).toBe("a big cat in a field");
    expect(checkPrompt("sunset over mountains, cinematic").ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. A whitespace-only prompt is not a generation request
// ---------------------------------------------------------------------------
describe("pass 34 — whitespace is not prompt content", () => {
  it("both schemas trim before the length floor", () => {
    const route = read("app/api/route/route.ts");
    const v1 = read("app/api/v1/images/generations/route.ts");
    // Pre-fix both read `z.string().min(3).max(2000)`: "   " passed, cleared
    // checkPrompt, and bought a billed provider/LLM call for nothing.
    expect(route).toMatch(/prompt: z\.string\(\)\.trim\(\)\.min\(3\)\.max\(2000\)/);
    expect(v1).toMatch(/prompt: z\.string\(\)\.trim\(\)\.min\(3\)\.max\(2000\)/);
  });

  it("the v1 API refuses it end to end", async () => {
    const { createApiKey } = await import("../lib/apikey");
    const user = await makeUser("blankv1", { credits: 100 });
    await prisma.creditGrant.create({
      data: { userId: user.id, source: "PURCHASE", amount: 100, remaining: 100, refType: "order", refId: `p34-blank-${stamp}` },
    });
    const { key } = await createApiKey(user.id, `p34-${stamp}`, 0);
    const before = await prisma.job.count({ where: { userId: user.id } });
    const res = await v1POST(
      new Request("http://localhost/api/v1/images/generations", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ prompt: "   ", model: "gpt" }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/invalid-input/);
    expect(await prisma.job.count({ where: { userId: user.id } })).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// 8. Every /api/* response honours the contract, 413 included
// ---------------------------------------------------------------------------
describe("pass 34 — the oversized-body refusal and the health catch path", () => {
  it("answers 413 as JSON with no-store (feedback route, 8 KB cap)", async () => {
    const res = await feedbackPOST(
      new Request("http://localhost/api/feedback", {
        method: "POST",
        // A fresh address per RUN: the route is IP-limited at 30/min and these
        // buckets live in Redis across local runs (ci-local clears rl:*), so a
        // recycled address would answer 429 and mask the assertion.
        headers: { "content-type": "application/json", "x-forwarded-for": `10.${(stamp / 1000) % 250}.9.${seq++ % 250}` },
        body: JSON.stringify({ message: "x".repeat(9 * 1024), category: "other" }),
      }),
    );
    // Pre-fix: `new Response("payload too large", { status: 413 })` — text/plain
    // with no Cache-Control, so a client's res.json() threw on the one path
    // outside the documented contract (lib/api.ts's errorResponse exists for
    // exactly this reason).
    expect(res.status).toBe(413);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(await res.json()).toMatchObject({ ok: false, error: "payload-too-large" });
  });

  it("the health handler's exception path carries no-store too", () => {
    const src = read("app/api/health/route.ts");
    const catchBlock = src.slice(src.indexOf("} catch (e) {"));
    expect(catchBlock).toContain("health-check-failed");
    expect(catchBlock).toContain('"Cache-Control": "no-store"');
  });
});

// ---------------------------------------------------------------------------
// 9. The authenticated page shells are charged to a bucket of their own
// ---------------------------------------------------------------------------
describe("pass 34 — /studio, /account and /admin are inside the limiter", () => {
  const saved = {
    page: process.env.MIDDLEWARE_PAGE_LIMIT,
    api: process.env.MIDDLEWARE_API_LIMIT,
    auth: process.env.MIDDLEWARE_AUTH_LIMIT,
    secret: process.env.NEXTAUTH_SECRET,
  };

  beforeAll(() => {
    process.env.NEXTAUTH_SECRET = saved.secret ?? "p34-proxy-secret-not-for-production-use";
    process.env.MIDDLEWARE_PAGE_LIMIT = "2";
    process.env.MIDDLEWARE_API_LIMIT = "1000";
    process.env.MIDDLEWARE_AUTH_LIMIT = "1000";
  });
  afterAll(() => {
    for (const [k, v] of [
      ["MIDDLEWARE_PAGE_LIMIT", saved.page],
      ["MIDDLEWARE_API_LIMIT", saved.api],
      ["MIDDLEWARE_AUTH_LIMIT", saved.auth],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("the page bucket binds while the API budget is a separate one", async () => {
    const { proxy } = await import("../proxy");
    const ip = `10.34.7.${seq++ % 250}`;
    const page = () =>
      new NextRequest(new URL("http://localhost:3100/studio"), { headers: { "x-forwarded-for": ip } });
    // Pre-fix a page path was charged the *api* bucket at MIDDLEWARE_API_LIMIT
    // (1000 here), so all three answered 200 — the shell rendered with no
    // ceiling while the same unit of work through /api/* was capped at 300/min.
    expect((await proxy(page())).status).toBe(200);
    expect((await proxy(page())).status).toBe(200);
    expect((await proxy(page())).status).toBe(429);
    const api = () => new NextRequest(new URL("http://localhost:3100/api/me"), { headers: { "x-forwarded-for": ip } });
    expect((await proxy(api())).status).toBe(200); // untouched by the page flood
    // The three shells share ONE page bucket: a fresh address spends it across
    // /studio, /account and /admin, and the third hit is the refused one.
    const ip2 = `10.34.8.${seq++ % 250}`;
    const at = (p: string) =>
      new NextRequest(new URL(`http://localhost:3100${p}`), { headers: { "x-forwarded-for": ip2 } });
    expect((await proxy(at("/studio"))).status).toBe(200);
    expect((await proxy(at("/account/security"))).status).toBe(200);
    expect((await proxy(at("/admin"))).status).toBe(429);
  });

  it("the matcher lists the shells, so the limiter is actually reachable", async () => {
    const { config } = await import("../proxy");
    const matchers = Array.isArray(config.matcher) ? config.matcher : [config.matcher];
    expect(matchers).toContain("/api/:path*");
    expect(matchers).toContain("/studio/:path*");
    expect(matchers).toContain("/account/:path*");
    expect(matchers).toContain("/admin/:path*");
  });
});

// ---------------------------------------------------------------------------
// 10. Ops: the gates, the compose wiring and the documented first run
// ---------------------------------------------------------------------------
describe("pass 34 — ops findings", () => {
  it("both image gates assert the glob members nothing pinned", () => {
    for (const f of [".github/workflows/ci.yml", "scripts/ci-local.sh"]) {
      const src = read(f);
      expect(src, f).toContain("test ! -e /app/PRODUCT_OUTLINE.md");
      expect(src, f).toContain("test ! -e /app/docker-compose.single.yml");
      expect(src, f).toContain("test ! -e /app/docker-compose.prod.yml");
      // `.env.example` is asserted by the WORKER stage only, and this test used
      // to prove it by "the string occurs somewhere in the file" — which the
      // worker block satisfies on its own. Pass 37 measured that the WEB
      // assertion it was really about could not fail (`.env.example` appears in
      // zero trace manifests and the web stage copies only
      // .next/standalone|static, public/ and prisma/), replaced it with names
      // that ARE traced, and pinned the split here so a future edit cannot put
      // the assertion back on the vacuous side. Slices, not `toContain` on the
      // whole file: each block ends with its own shape line.
      const webEnd = src.indexOf("web image shape OK");
      const workerEnd = src.indexOf("worker image shape OK");
      expect(webEnd, f).toBeGreaterThan(0);
      expect(workerEnd, f).toBeGreaterThan(webEnd);
      const webBlock = src.slice(0, webEnd);
      const workerBlock = src.slice(webEnd, workerEnd);
      expect(webBlock, f).not.toContain("test ! -e /app/.env.example");
      expect(workerBlock, f).toContain("test ! -e /app/.env.example");
      for (const name of [
        "instrumentation-client.ts",
        "sentry.server.config.ts",
        "sentry.edge.config.ts",
        "vitest.setup.ts",
      ]) {
        expect(webBlock, `${f}: web gate must assert ${name}`).toContain(`test ! -e /app/${name}`);
      }
    }
  });

  it("the prod compose forwards S3_FORCE_PATH_STYLE instead of pinning it", () => {
    const src = read("docker-compose.prod.yml");
    expect(src).toContain("S3_FORCE_PATH_STYLE: ${S3_FORCE_PATH_STYLE:-false}");
    expect(src).not.toMatch(/^\s*S3_FORCE_PATH_STYLE: "false"$/m);
  });

  it("the dev compose's migrate carries an image pin like its siblings", () => {
    const src = read("docker-compose.yml");
    const migrate = src.slice(0, src.indexOf("build:", src.indexOf("migrate:")));
    expect(migrate).toContain("image: ${IMAGE_WORKER:-image-gen-worker:latest}");
  });

  it("ci-local plants the build-host leaks and removes them on every exit", () => {
    const src = read("scripts/ci-local.sh");
    expect(src).toMatch(/if \[ ! -e \.env \] && \[ ! -e prisma\/dev\.db \]; then/);
    expect(src).toContain("PLANTED_ENV=1");
    expect(src).toMatch(/PLANTED_ENV:-\}" \]; then rm -f \.env prisma\/dev\.db/);
  });

  it("the backup loops refuse to fail silently on an unwritable ./backups", () => {
    for (const f of ["docker-compose.yml", "docker-compose.single.yml"]) {
      const src = read(f);
      const checks = src.split("\n").filter((l) => l.includes("[ ! -w /backups ]"));
      expect(checks.length, `${f} must check both backup loops`).toBe(2);
    }
    if (typeof process.getuid === "function" && process.getuid() !== 0) {
      // The check itself, extracted from the real file (compose's `$$` escape
      // undone) and run against a directory uid 1000 cannot write: this is the
      // state a fresh clone produces, and it must say so.
      const line = read("docker-compose.yml")
        .split("\n")
        .find((l) => l.includes("[ ! -w /backups ]") && l.includes("[backup] "))!;
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p34-backups-"));
      const probe = line.replace(/\$\$/g, "$").replace(/\/backups/g, dir);
      try {
        fs.chmodSync(dir, 0o500);
        // The loop only echoes (it does not exit non-zero), so both streams are
        // merged rather than read off an exception.
        const runProbe = () =>
          execFileSync("sh", ["-c", `{ ${probe} } 2>&1`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        expect(runProbe()).toMatch(/not writable/i);
        // Writable: silent.
        fs.chmodSync(dir, 0o700);
        expect(runProbe()).toBe("");
      } finally {
        fs.chmodSync(dir, 0o700);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("release.md gives the container form the documented host can run", () => {
    const src = read("docs/release.md");
    expect(src).toContain("run --rm worker npx tsx scripts/promote-admin.ts");
    expect(src).not.toMatch(/^首次启动后执行：`npx tsx/m);
  });

  it("MIDDLEWARE_PAGE_LIMIT reaches every deployment surface", () => {
    expect(read(".env.example")).toContain("MIDDLEWARE_PAGE_LIMIT");
    for (const f of ["docker-compose.yml", "docker-compose.single.yml", "docker-compose.prod.yml"]) {
      expect(read(f), f).toContain("MIDDLEWARE_PAGE_LIMIT:");
    }
    expect(read(".github/workflows/ci.yml")).toContain("MIDDLEWARE_PAGE_LIMIT");
    expect(read("scripts/ci-local.sh")).toContain("MIDDLEWARE_PAGE_LIMIT");
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
