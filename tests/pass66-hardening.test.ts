import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHmac } from "crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

// Pass 66. Findings and the cases that reproduce them:
//
//   - readBodyCapped kept one retained entry per HTTP chunk. The byte cap held,
//     the HEAP did not: a 4 MB JSON body in one-byte chunks, or the payment
//     webhook's 256 KiB (unauthenticated), could end the web process before any
//     check. The worker's provider reader had the same shape.
//   - The prompt list knew only the formal Chinese nouns and only the
//     U+1D00 small capitals, so 做爱/性交/强奸/性侵/成人视频 and `ᴄʜɪʟᴅ ᴘᴏʀɴ`
//     (mixed IPA + small-cap letters) walked into the video lane, which has no
//     output audit.
//   - StorageDriver.get swallowed every error into null. The worker reads null
//     as "the reference image is permanently gone": terminal failure, then the
//     terminal branch deletes the customer's upload. Any transient S3/local
//     fault destroyed a paid edit's input.
//   - A 2xx provider body that could not be used was retried on the billed
//     create call. Same for a gateway key with no image endpoint: it was sent
//     to the VENDOR's host.
//   - The moderation refusal budget counted only image-flagged:, so an audit
//     that could not run was a refunded provider-spend loop.
//   - A reversed Paddle refund arriving before its approval's retry was
//     re-added by the approval; a Stripe refund that FAILED was IGNORED.
//   - A negative-amount grant (the legacy row class the repair script exists
//     for) could not be written by any path, including the repair script.
//   - A retried video delivery whose superseded-object delete failed orphaned
//     the object beyond erasure; the video poll lease was shorter than the
//     download+put it is supposed to cover.
//   - queue-full's plain-Error 429 had no Retry-After; the GET credentials
//     callback was an anonymous 500; the admin/keys re-proof transactions
//     inherited Prisma's 5s budget the erasure wait is documented to exceed.

const STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "p66-storage-"));
process.env.STORAGE_DRIVER = "local";
process.env.LOCAL_STORAGE_DIR = STORAGE_DIR;

const REPO = path.resolve(__dirname, "..");
const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;

const getServerSession = vi.fn();
vi.mock("next-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-auth")>();
  return { ...actual, getServerSession: (...args: unknown[]) => getServerSession(...args) };
});

const { prisma } = await import("../lib/prisma");
const { readBodyCapped } = await import("../lib/api");
const { readBodyCapped: readProviderBody, saveBase64Image } = await import("../lib/store");
const { checkPrompt } = await import("../lib/safety");
const { isPermanentProviderError } = await import("../lib/worker-errors");
const { getModelVerseConfig, getArkKey, getAliyunKey, _resetKeysCacheForTests } = await import("../lib/keys");
const { getStorage, newStorageKey, _resetStorageForTests } = await import("../lib/storage");
const { reclaimStoredArtifact, POLL_LEASE_MS } = await import("../lib/queue");
const { collectUserArtifactKeys } = await import("../lib/erasure");
const { moderationRefusalBudget } = await import("../lib/safety");
const { fail } = await import("../lib/api");

const madeEmails: string[] = [];

async function makeUser(label: string, extra: Record<string, unknown> = {}) {
  const email = `p66-${label}-${stamp}@test.dev`;
  madeEmails.push(email);
  return prisma.user.create({
    data: { email, name: label, passwordHash: "x", emailVerified: new Date(), ...extra },
  });
}

function asUser(id: string) {
  getServerSession.mockResolvedValue({ user: { id, sv: 0, totpPending: false } });
}

afterEach(() => {
  getServerSession.mockReset();
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { startsWith: `p66-` } } });
  await prisma.$disconnect();
  fs.rmSync(STORAGE_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. Body caps bound the heap, not only the byte count
// ---------------------------------------------------------------------------
describe("pass 66 — capped body reads do not retain one object per chunk", () => {
  function tinyChunkRequest(bytes: number): Request {
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < bytes) controller.enqueue(new Uint8Array([120]));
        else controller.close();
      },
    });
    return new Request("http://localhost/api/edit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit);
  }

  it("reassembles a 1-byte-chunk body exactly and refuses one byte over the cap", async () => {
    const ok = await readBodyCapped(tinyChunkRequest(50_000), 64 * 1024);
    expect("raw" in ok && ok.raw.length).toBe(50_000);
    expect("raw" in ok && ok.raw).toBe("x".repeat(50_000));

    const over = await readBodyCapped(tinyChunkRequest(101), 100);
    expect(over).toEqual({ tooLarge: true });
  });

  it("the provider reader has the same contract", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 2000; i++) controller.enqueue(new TextEncoder().encode("ab"));
        controller.close();
      },
    });
    const res = new Response(body);
    const out = await readProviderBody(res, 8192);
    expect(out.toString("utf8")).toBe("ab".repeat(2000));

    const big = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(200));
          controller.close();
        },
      }),
    );
    await expect(readProviderBody(big, 100)).rejects.toThrow(/download-too-large/);
  });

  it("neither reader retains a per-chunk array (structural gate)", () => {
    for (const file of ["lib/api.ts", "lib/store.ts"]) {
      const src = fs.readFileSync(path.join(REPO, file), "utf8");
      expect(src, `${file} must not accumulate one entry per HTTP chunk`).not.toMatch(/chunks\.push/);
      expect(src, `${file} must grow a single bounded accumulator`).toMatch(/capacity = Math\.min\(maxBytes/);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. The prompt list knows the ordinary spellings and the small-cap alphabet
// ---------------------------------------------------------------------------
describe("pass 66 — prompt filter spellings", () => {
  it("blocks the explicit Chinese forms and mixed small-capital spellings", () => {
    for (const prompt of [
      "儿童做爱",
      "幼女性交",
      "强奸儿童",
      "性侵",
      "强奸",
      "成人视频",
      "未成年性爱",
      "ᴄʜɪʟᴅ ᴘᴏʀɴ",
      "ɴᴜᴅᴇ woman",
      "ᴄʜɪʟᴅ ᴀʙᴜsᴇ",
    ]) {
      expect(checkPrompt(prompt).ok, prompt).toBe(false);
    }
  });

  it("keeps ordinary prose and 性 inside unrelated words allowed", () => {
    for (const prompt of [
      "a big cat sitting on a sofa",
      "under a gentle sky",
      "性格分析",
      "成人教育课程",
      "儿童图书插画",
    ]) {
      expect(checkPrompt(prompt).ok, prompt).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. A storage FAULT is not a missing object
// ---------------------------------------------------------------------------
describe("pass 66 — storage.get distinguishes missing from faulted", () => {
  it("returns null for a missing key and rejects a real read error", async () => {
    _resetStorageForTests();
    await expect(getStorage().get("img/does-not-exist.png")).resolves.toBeNull();

    const key = newStorageKey("png");
    await getStorage().put(key, Buffer.from("data"));
    if (process.getuid?.() === 0) return; // root ignores the mode bits
    // Deny READ on the object itself: a read-only parent directory still lets
    // the owner read a file (unlink needs directory write, read does not).
    const file = path.join(STORAGE_DIR, key);
    fs.chmodSync(file, 0o000);
    try {
      await expect(getStorage().get(key)).rejects.toThrow();
    } finally {
      fs.chmodSync(file, 0o600);
    }
  });

  it("refuses a base64 reference that decodes to nothing", async () => {
    await expect(saveBase64Image("!".repeat(120))).rejects.toThrow(/empty-image/);
    // A real one-byte PNG header prefix still has to reach the raster pipeline;
    // a genuine data payload is not what this test is about.
    await expect(saveBase64Image("aGVsbG8=")).resolves.toMatch(/^img\//);
  });
});

// ---------------------------------------------------------------------------
// 4. Provider faults are classified by what a retry can change
// ---------------------------------------------------------------------------
describe("pass 66 — a billed 2xx with an unusable body is permanent", () => {
  it("classifies unusable 2xx bodies and keeps genuine transients retryable", () => {
    expect(isPermanentProviderError("gpt-image-2 returned no b64_json")).toBe(true);
    expect(isPermanentProviderError("wan-image returned no images")).toBe(true);
    expect(isPermanentProviderError("seedream returned 1 of 4 images")).toBe(true);
    expect(isPermanentProviderError("Unexpected token '<', \"<html>\" is not valid JSON")).toBe(true);
    expect(isPermanentProviderError("socket hang up")).toBe(false);
    expect(isPermanentProviderError("503 Service Unavailable")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. A gateway key never travels to the vendor's host
// ---------------------------------------------------------------------------
describe("pass 66 — gateway keys fail closed without an image endpoint", () => {
  const savedHome = process.env.HOME;
  let home = "";

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    delete process.env.MODELVERSE_IMAGE_API_KEY;
    delete process.env.ARK_IMAGE_API_KEY;
    delete process.env.ALIYUN_API_KEY;
    delete process.env.DASHSCOPE_API_KEY;
    _resetKeysCacheForTests();
    if (home) {
      fs.rmSync(home, { recursive: true, force: true });
      home = "";
    }
  });

  function writeConfig(config: unknown) {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "p66-home-"));
    fs.mkdirSync(path.join(home, ".cc-proxy"), { recursive: true });
    fs.writeFileSync(path.join(home, ".cc-proxy", "config.json"), JSON.stringify(config));
    process.env.HOME = home;
    _resetKeysCacheForTests();
  }

  it("refuses a ModelVerse relay key with no base_url", () => {
    writeConfig({ gateways: { modelverse: { api_keys: ["relay-key"] } } });
    expect(getModelVerseConfig()).toBeNull();
  });

  it("refuses Ark and DashScope relay keys with no image-capable endpoint", () => {
    writeConfig({ gateways: { ark: { api_keys: ["relay-ark"] }, aliyun: { api_keys: ["relay-ali"] } } });
    expect(getArkKey()).toBeUndefined();
    expect(getAliyunKey()).toBeUndefined();
    writeConfig({
      gateways: {
        ark: { api_keys: ["relay-ark"], base_url: "https://relay.example/api/coding/v1" },
        aliyun: { api_keys: ["relay-ali"], base_url: "https://relay.example/compatible-mode/v1" },
      },
    });
    expect(getArkKey()).toBeUndefined(); // a chat URL is not an image endpoint
    expect(getAliyunKey()).toBe("relay-ali");
  });
});

// ---------------------------------------------------------------------------
// 6. Both refunded-provider-spend refusals count toward the budget
// ---------------------------------------------------------------------------
describe("pass 66 — the moderation budget counts an audit that could not run", () => {
  it("counts image-flagged and safety-audit-unavailable together", async () => {
    const user = await makeUser("budget");
    const row = (error: string, i: number) => ({
      userId: user.id,
      model: "gpt",
      prompt: "x",
      costCredits: 1,
      images: "[]",
      status: "failed",
      error,
      finishedAt: new Date(Date.now() - i * 1000),
    });
    await prisma.job.createMany({
      data: Array.from({ length: 9 }, (_, i) =>
        row(i % 2 === 0 ? "image-flagged: moderation rejected the generated image" : "safety-audit-unavailable: detector down", i),
      ),
    });
    expect((await moderationRefusalBudget(user.id)).ok).toBe(true);
    await prisma.job.create({
      data: row("safety-audit-unavailable: detector down", 20),
    });
    const spent = await moderationRefusalBudget(user.id);
    expect(spent.ok).toBe(false);
    expect(spent.refused).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// 7. Refund reversals: Stripe's failed refund, Paddle's delivery order
// ---------------------------------------------------------------------------
describe("pass 66 — a refund that did not happen leaves the accumulator", () => {
  const WEBHOOK_SECRET = "whsec_pass66_secret";

  function stripeSignature(payload: string, secret: string): string {
    const t = Math.floor(Date.now() / 1000);
    const v1 = createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex");
    return `t=${t},v1=${v1}`;
  }
  function stripeEvent(type: string, extra: Record<string, unknown> = {}) {
    return JSON.stringify({
      id: `evt_p66_${stamp}_${Math.random()}`,
      object: "event",
      type,
      data: { object: { payment_intent: `pi_p66_${stamp}`, ...extra } },
    });
  }

  it("maps a failed/canceled Stripe refund to a keyed negative delta", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
    try {
      const { StripeProvider } = await import("../lib/payments/stripe");
      const provider = new StripeProvider({ webhookSecret: WEBHOOK_SECRET });
      const verify = async (type: string, extra: Record<string, unknown>) => {
        const payload = stripeEvent(type, extra);
        return provider.verifyWebhook(
          payload,
          new Headers({ "stripe-signature": stripeSignature(payload, WEBHOOK_SECRET) }),
        );
      };
      const failed = await verify("refund.failed", { id: "re_p66_a", amount: 2500, status: "failed" });
      expect(failed && !("ignored" in failed)).toBe(true);
      if (!failed || "ignored" in failed) throw new Error("expected a parsed event");
      expect(failed.type).toBe("refunded");
      expect(failed.refundAmountUsd).toBe(-25);
      expect(failed.refundAdjustmentId).toBe("re_p66_a");

      const canceled = await verify("charge.refund.updated", { id: "re_p66_b", amount: 1000, status: "canceled" });
      expect(canceled && !("ignored" in canceled) && canceled.refundAmountUsd).toBe(-10);

      // A successful refund update is not a reversal and must stay ignored.
      const succeeded = await verify("refund.updated", { id: "re_p66_c", amount: 1000, status: "succeeded" });
      expect(succeeded).toEqual({ ignored: true });
    } finally {
      delete process.env.STRIPE_SECRET_KEY;
    }
  });
});

describe("pass 66 — a Paddle reversal survives an out-of-order approval retry", () => {
  const PADDLE_SECRET = "pdl_ntfset_p66";
  const saved = {
    provider: process.env.PAYMENT_PROVIDER,
    key: process.env.PADDLE_API_KEY,
    secret: process.env.PADDLE_WEBHOOK_SECRET,
  };

  beforeAll(() => {
    process.env.PAYMENT_PROVIDER = "paddle";
    process.env.PADDLE_API_KEY = "pdl_sdbx_p66_dummy";
    process.env.PADDLE_WEBHOOK_SECRET = PADDLE_SECRET;
  });

  afterAll(async () => {
    const { _resetPaymentProviderForTests } = await import("../lib/payments");
    _resetPaymentProviderForTests();
    for (const [k, v] of [
      ["PAYMENT_PROVIDER", saved.provider],
      ["PADDLE_API_KEY", saved.key],
      ["PADDLE_WEBHOOK_SECRET", saved.secret],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("does not re-add an adjustment whose reversal already arrived", async () => {
    const { _resetPaymentProviderForTests } = await import("../lib/payments");
    _resetPaymentProviderForTests();
    const { POST } = await import("../app/api/webhooks/payment/route");
    const { grantCreditsTx } = await import("../lib/ledger");

    const user = await makeUser("paddle-order");
    const order = await prisma.order.create({
      data: {
        userId: user.id,
        kind: "pack",
        status: "paid",
        amountUsd: 49.99,
        credits: 6000,
        provider: "paddle",
        providerOrderId: `txn_p66_${stamp}`,
        idempotencyKey: `p66-${stamp}-${Math.random()}`,
      },
    });
    await prisma.$transaction((tx) => grantCreditsTx(tx, user.id, "PURCHASE", 6000, null, "order", order.id));
    const txn = order.providerOrderId as string;

    const adjustment = (id: string, overrides: Record<string, unknown>) => ({
      id,
      action: "refund",
      status: "approved",
      type: "partial",
      transaction_id: txn,
      currency_code: "USD",
      items: [],
      totals: { subtotal: "2500", tax: "0", total: "2500", fee: "0", earnings: "0", currency_code: "USD" },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...overrides,
    });
    const request = (notif: string, body: Record<string, unknown>) => {
      const payload = JSON.stringify({
        event_id: notif,
        event_type: "adjustment.updated",
        occurred_at: new Date().toISOString(),
        data: body,
      });
      const t = Math.floor(Date.now() / 1000);
      const sig = createHmac("sha256", PADDLE_SECRET).update(`${t}:${payload}`).digest("hex");
      return new NextRequest("http://localhost/api/webhooks/payment", {
        method: "POST",
        headers: { "content-type": "application/json", "paddle-signature": `ts=${t};h1=${sig}` },
        body: payload,
      });
    };

    const adj = `adj_p66_${stamp}`;
    // The reversal is processed FIRST (its approval's first delivery is lost,
    // so Paddle retries it afterwards under a new notification id).
    expect((await POST(request(`ntf_p66_${stamp}_r`, adjustment(adj, { status: "reversed" })))).status).toBe(200);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).refundedAmountUsd).toBe(0);

    expect((await POST(request(`ntf_p66_${stamp}_a`, adjustment(adj, {})))).status).toBe(200);
    const afterRetry = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(afterRetry.refundedAmountUsd).toBe(0);
    expect(afterRetry.status).toBe("paid");

    // Control: a different adjustment still accumulates.
    expect((await POST(request(`ntf_p66_${stamp}_b`, adjustment(`adj_p66_other_${stamp}`, {})))).status).toBe(200);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).refundedAmountUsd).toBe(25);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 8. A failed superseded-artifact delete is recorded, not lost
// ---------------------------------------------------------------------------
describe("pass 66 — an orphaned superseded artifact stays reclaimable", () => {
  it("records the key when the delete fails, and erasure sees it", async () => {
    _resetStorageForTests();
    const user = await makeUser("stale");
    const job = await prisma.job.create({
      data: {
        userId: user.id,
        model: "gpt",
        prompt: "x",
        costCredits: 1,
        images: "[]",
      },
    });
    const key = newStorageKey("mp4");
    await getStorage().put(key, Buffer.from("segment"));
    const dir = path.join(STORAGE_DIR, "img");
    if (process.getuid?.() === 0) return;
    fs.chmodSync(dir, 0o500);
    try {
      await expect(reclaimStoredArtifact(job.id, key)).resolves.toBe(false);
    } finally {
      fs.chmodSync(dir, 0o700);
    }
    const row = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(row.staleArtifacts).toEqual([key]);
    expect(await collectUserArtifactKeys(prisma, user.id)).toContain(key);
  });
});

// ---------------------------------------------------------------------------
// 9. Small contract corrections
// ---------------------------------------------------------------------------
describe("pass 66 — contract corrections", () => {
  it("sends Retry-After on a plain-Error 429 (queue-full)", async () => {
    const res = fail(new Error("queue-full: max 5 concurrent jobs — wait for one to finish"));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("10");
  });

  it("refuses a GET of the credentials callback instead of next-auth's 500", async () => {
    const { GET } = await import("../app/api/auth/[...nextauth]/route");
    const req = new NextRequest("http://localhost/api/auth/callback/credentials");
    const res = await GET(req, { params: Promise.resolve({ nextauth: ["callback", "credentials"] }) } as never);
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST");

    const escaped = new NextRequest("http://localhost/api/auth/%63allback/credentials");
    const escapedRes = await GET(escaped, {
      params: Promise.resolve({ nextauth: ["callback", "credentials"] }),
    } as never);
    expect(escapedRes.status).toBe(405);
  });

  it("keeps the video poll lease above poll + download + put", () => {
    // 30s poll + 120s download + 300s S3 put = 450s, the longest stretch with no
    // extendPollLease call; the lease must cover it and stay under the 10-minute
    // polling reap cutoff.
    expect(POLL_LEASE_MS).toBeGreaterThanOrEqual(450_000);
    expect(POLL_LEASE_MS).toBeLessThan(600_000);
  });

  it("names the truncated tables in the account export", async () => {
    const { POST } = await import("../app/api/account/export/route");
    const user = await makeUser("export");
    await prisma.ledgerEntry.createMany({
      data: Array.from({ length: 5001 }, (_, i) => ({
        userId: user.id,
        type: "CHECKIN",
        creditsDelta: 1,
        balanceAfter: i + 1,
      })),
    });
    asUser(user.id);
    const res = await POST(new Request("http://localhost/api/account/export", { method: "POST" }));
    const body = (await res.json()) as {
      truncated: boolean;
      truncatedTables: string[];
      data: { ledger: unknown[]; images: unknown[] };
    };
    expect(res.status).toBe(200);
    expect(body.truncated).toBe(true);
    expect(body.truncatedTables).toEqual(["ledger"]);
    expect(body.data.ledger.length).toBe(5000);
    expect(body.data.images.length).toBe(0);
  }, 30_000);
});
