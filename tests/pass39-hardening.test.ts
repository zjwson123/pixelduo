import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// Pass 39. Each case below was confirmed to FAIL against the stashed pre-fix
// source.
//
//   - P3 worker: the two moderation branches deleted the attempt's delivered
//     objects unconditionally, even when failJob had STOOD DOWN because a peer
//     had taken the row over (the zombie class passes 31/37 close everywhere
//     else). A paused worker whose job a peer re-claimed and delivered woke up,
//     found its images flagged/unavailable and deleted the peer's delivered
//     files: job `done`, paid, gallery 404.
//   - P3 queue: the recovery sweep's `expect` observation guarded the fresh read
//     but not the two CAS writes. A peer poll claim between them rewrites
//     worker/heartbeatAt but leaves status='polling', so the sweep's status-only
//     CAS still matched and requeued/failed a freshly claimed, live attempt.
//   - P3 provider: an unusable task id (non-string, empty, >200 chars, NUL) was
//     rejected AFTER the billed create call, with a message no permanent
//     classifier matches — so the job retried and created (and paid for) up to
//     maxAttempts upstream tasks, none of them pollable.
//   - P3 queue: failJob repaired lone surrogates but not U+0000, which is
//     well-formed UTF-16. PostgreSQL text rejects it (22021), so the
//     failure-bookkeeping transaction rolled back: no retry/terminal decision,
//     no refund, no reclaim, and the worker's catch died on its first statement.
//   - P4 queue: the pass-38 idempotency shape slot concatenated the client key
//     without a delimiter, so a t2v key "ref:K" and an i2v key "K" computed the
//     same stored key and the second request was answered with the first job
//     while its upload was deleted.
const LEDGER_HOOK: { fn: null | (() => Promise<void>) } = { fn: null };

vi.mock("../lib/ledger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/ledger")>();
  return {
    ...actual,
    dbNow: async (client: Parameters<typeof actual.dbNow>[0]) => {
      if (LEDGER_HOOK.fn) {
        const hook = LEDGER_HOOK.fn;
        LEDGER_HOOK.fn = null;
        await hook();
      }
      return actual.dbNow(client);
    },
  };
});

const generateImagesMock = vi.fn();
vi.mock("../lib/providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/providers")>();
  return {
    ...actual,
    generateImages: (...args: unknown[]) => generateImagesMock(...args),
  };
});

const analyzeMock = vi.fn();
vi.mock("../lib/safety", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/safety")>();
  return {
    ...actual,
    analyzeAllImagesSequentially: (...args: unknown[]) => analyzeMock(...args),
  };
});

// A scratch storage root: the local driver is the one this suite can prove
// object deletion against without a bucket.
const STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "p39-storage-"));
process.env.STORAGE_DRIVER = "local";
process.env.LOCAL_STORAGE_DIR = STORAGE_DIR;
delete process.env.REDIS_URL;

const { prisma } = await import("../lib/prisma");
const { getStorage, _resetStorageForTests } = await import("../lib/storage");
const { grantCreditsTx } = await import("../lib/ledger");
const { createMediaJob, failJob } = await import("../lib/queue");
const { isPermanentProviderError } = await import("../lib/worker-errors");
const { createVideoTask } = await import("../lib/providers");
const { processImageJob } = await import("../scripts/worker");
const { ipBucketAddress, rateLimit, _resetLimiterForTests } = await import("../lib/rate-limit");
const { enforceUserRateLimit, fail } = await import("../lib/api");
const { proxy } = await import("../proxy");
const { NextRequest } = await import("next/server");
const { authOptions } = await import("../lib/auth");
const { reserveLoginAttempt } = await import("../lib/login-guard");
const { eraseUserArtifacts } = await import("../lib/erasure");
const { getArkVideoConfig, getAliyunTaskUrl, _resetKeysCacheForTests } = await import("../lib/keys");
const bcrypt = (await import("bcryptjs")).default;
const { randomBytes } = await import("crypto");

const stamp = Date.now();
let seq = 0;

async function makeUser(tag: string, extra: Record<string, unknown> = {}) {
  return prisma.user.create({
    data: {
      email: `p39-${tag}-${stamp}-${seq++}@test.dev`,
      passwordHash: "x",
      emailVerified: new Date(),
      ...extra,
    },
  });
}

async function fund(userId: string, credits: number) {
  await prisma.$transaction((tx) =>
    grantCreditsTx(tx, userId, "PURCHASE", credits, null, "none", null, "p39 test grant"),
  );
}

beforeAll(() => {
  _resetStorageForTests();
});

afterEach(() => {
  LEDGER_HOOK.fn = null;
  generateImagesMock.mockReset();
  analyzeMock.mockReset();
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { contains: `p39-` } } });
  await prisma.$disconnect();
  fs.rmSync(STORAGE_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. A stood-down attempt must not delete objects a peer still owns
// ---------------------------------------------------------------------------
describe("pass 39 — moderation branches respect failJob's stand-down", () => {
  it("keeps a checkpointed object when the row was taken over during the audit", async () => {
    const user = await makeUser("zombie-moderation", {
      plan: "pro",
      planRenewsAt: new Date(Date.now() + 24 * 3600_000),
    });
    const createdAt = new Date();
    const job = await prisma.job.create({
      data: {
        userId: user.id,
        model: "gpt",
        mediaType: "image",
        quality: "medium",
        count: 1,
        prompt: "zombie moderation",
        costCredits: 8,
        images: "[]",
        status: "running",
        worker: "p39-stale",
        startedAt: createdAt,
        heartbeatAt: createdAt,
        maxAttempts: 3,
      },
    });
    const key = `img/p39-${stamp}-${seq++}.png`;
    await getStorage().put(key, Buffer.from("not really a png"), "image/png");

    // The attempt checkpoints its image while it still holds the row...
    generateImagesMock.mockImplementation(async (args: { onImage?: (img: unknown) => Promise<void> }) => {
      const img = { key, model: "gpt" };
      if (args.onImage) await args.onImage(img);
      return [img];
    });
    // ...then a peer takes the row over DURING the moderation call (the same
    // takeover a poll claim or recovery sweep performs), and the audit answers
    // "flagged".
    analyzeMock.mockImplementation(async () => {
      await prisma.job.update({
        where: { id: job.id },
        data: { worker: "p39-peer", heartbeatAt: new Date() },
      });
      return [{ flagged: true, unavailable: false, checked: true, provider: "test" }];
    });

    const claimed = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    await processImageJob(claimed, "p39-stale");

    // Pre-fix: failJob stood down (the row is not held by p39-stale any more)
    // but the branch deleted the rows unconditionally — the key the peer's
    // checkpoint names was destroyed.
    const stored = await getStorage().get(key);
    expect(stored).not.toBeNull();
    const after = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    // The peer's attempt is untouched: the stale worker changed nothing.
    expect(after.status).toBe("running");
    expect(after.worker).toBe("p39-peer");
    expect(after.attempts).toBe(0);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 2. The sweep's observation must be part of the CAS, not just the read
// ---------------------------------------------------------------------------
describe("pass 39 — a stale recovery observation cannot requeue a claimed job", () => {
  it("stands down when a peer rewrites heartbeatAt between the read and the write", async () => {
    const user = await makeUser("sweep-window");
    const t0 = new Date(Date.now() - 20 * 60_000);
    const job = await prisma.job.create({
      data: {
        userId: user.id,
        model: "gpt",
        mediaType: "image",
        quality: "medium",
        count: 1,
        prompt: "sweep window",
        costCredits: 0,
        images: "[]",
        status: "polling",
        worker: "p39-peer",
        startedAt: t0,
        heartbeatAt: t0,
        maxAttempts: 3,
        attempts: 0,
      },
    });
    const observation = {
      status: job.status,
      heartbeatAt: job.heartbeatAt,
      startedAt: job.startedAt,
    };

    // The window between failJob's fresh read and its CAS: a peer poll claim
    // rewrites worker + heartbeatAt but leaves status='polling', so the
    // status-only predicate used to match anyway.
    LEDGER_HOOK.fn = async () => {
      await prisma.job.update({
        where: { id: job.id },
        data: { worker: "p39-other", heartbeatAt: new Date() },
      });
    };

    const transitioned = (await failJob(job.id, "stuck-timeout: worker heartbeat expired", {
      expect: observation,
    })) as unknown as boolean;

    const after = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    // Pre-fix: attempts 1, status queued, worker p39-other — a freshly claimed
    // attempt was requeued out from under its holder.
    expect(after.status).toBe("polling");
    expect(after.attempts).toBe(0);
    expect(after.worker).toBe("p39-other");
    expect(transitioned).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. An unusable provider task id is terminal, not a re-billing retry
// ---------------------------------------------------------------------------
describe("pass 39 — an unusable provider task id fails terminally", () => {
  const priorKey = process.env.ARK_IMAGE_API_KEY;
  const priorMock = process.env.MOCK_IMAGE_PROVIDER;
  beforeAll(() => {
    process.env.ARK_IMAGE_API_KEY = "p39-test-ark-key";
    // ci-local exports MOCK_IMAGE_PROVIDER=1; the mock returns a fabricated id
    // BEFORE the provider call, so this suite must force the real lane.
    process.env.MOCK_IMAGE_PROVIDER = "0";
  });
  afterAll(() => {
    if (priorKey === undefined) delete process.env.ARK_IMAGE_API_KEY;
    else process.env.ARK_IMAGE_API_KEY = priorKey;
    if (priorMock === undefined) delete process.env.MOCK_IMAGE_PROVIDER;
    else process.env.MOCK_IMAGE_PROVIDER = priorMock;
    vi.unstubAllGlobals();
  });

  it("rejects a non-string id with a permanently-classified error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ id: 123 }), { status: 200 })),
    );
    await expect(
      createVideoTask({ model: "seedance", prompt: "p39 task id", durationSec: 5 }),
    ).rejects.toThrow(/unusable task id/);
    try {
      await createVideoTask({ model: "seedance", prompt: "p39 task id", durationSec: 5 });
    } catch (e) {
      expect(isPermanentProviderError(e instanceof Error ? e.message : String(e))).toBe(true);
    }
  });

  it("refuses an id carrying U+0000 before it can reach Job.providerTaskId", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ id: "task\u0000id" }), { status: 200 })),
    );
    // Pre-fix: accepted (only type/length were checked), and the 22021 it then
    // caused in setJobPolling was classified transient — a billed upstream task
    // per attempt.
    await expect(
      createVideoTask({ model: "seedance", prompt: "p39 task id", durationSec: 5 }),
    ).rejects.toThrow(/unusable task id/);
  });
});

// ---------------------------------------------------------------------------
// 4. failJob must survive a provider error containing U+0000
// ---------------------------------------------------------------------------
describe("pass 39 — failure bookkeeping survives a NUL in the provider's text", () => {
  it("records the terminal failure and refunds instead of rolling back", async () => {
    const user = await makeUser("nul-error");
    const job = await prisma.job.create({
      data: {
        userId: user.id,
        model: "gpt",
        mediaType: "image",
        quality: "medium",
        count: 1,
        prompt: "nul error",
        costCredits: 0,
        images: "[]",
        status: "running",
        worker: "p39-nul",
        startedAt: new Date(),
        heartbeatAt: new Date(),
        maxAttempts: 1,
      },
    });
    // Pre-fix: `"a\u0000b".isWellFormed()` is true, so the NUL reached the
    // UPDATE as a text parameter — 22021 aborted the transaction and the whole
    // terminal transition (status, refund, reclaim) was rolled back.
    await expect(
      failJob(job.id, "provider said: BOOM\u0000 (401)", { terminal: true, worker: "p39-nul" }),
    ).resolves.toBe(true);

    const after = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.status).toBe("failed");
    expect(after.error).toMatch(/BOOM/);
    expect(after.error).not.toContain("\u0000");
  });
});

// ---------------------------------------------------------------------------
// 5. The idempotency key's operation slot must not be forgeable by the key
// ---------------------------------------------------------------------------
describe("pass 39 — a client key cannot reproduce another operation's slot", () => {
  it("does not answer an i2v request with the t2v job whose key is 'ref:K'", async () => {
    const user = await makeUser("idem-alias");
    await fund(user.id, 200);
    const common = {
      userId: user.id,
      model: "gpt",
      mediaType: "image" as const,
      quality: "medium" as const,
      count: 1,
      prompt: "p39 idem alias",
    };
    // A: no reference, key "ref:K" → shape `media:image:gpt:ref:K`
    const a = await createMediaJob({ ...common, idempotencyKey: "ref:K" });
    expect(a.created).toBe(true);
    // B: reference, key "K" → pre-fix the SAME stored string; B was answered
    // with A's job (duplicate:true) and its upload was deleted by the route.
    const b = await createMediaJob({
      ...common,
      idempotencyKey: "K",
      refImageKey: `img/p39-ref-${stamp}-${seq++}.png`,
    });
    expect(b.created).toBe(true);
    expect(b.job.id).not.toBe(a.job.id);
    expect(b.job.refImageKey).toBeTruthy();
  });

  it("still finds a retry stored under the pass-38 spelling (deploy-spanning retry)", async () => {
    const user = await makeUser("idem-prior");
    await fund(user.id, 100);
    const input = {
      userId: user.id,
      model: "gpt" as const,
      mediaType: "image" as const,
      quality: "medium" as const,
      count: 1,
      prompt: "p39 idem prior spelling",
      idempotencyKey: "prior-K",
      refImageKey: `img/p39-prior-${stamp}-${seq++}.png`,
    };
    // The row a pass-38 process would have written for this exact operation.
    const prior = await prisma.job.create({
      data: {
        userId: user.id,
        model: "gpt",
        mediaType: "image",
        quality: "medium",
        count: 1,
        prompt: input.prompt,
        costCredits: 0,
        images: "[]",
        refImageKey: input.refImageKey,
        idempotencyKey: `${user.id}:media:image:gpt:ref:prior-K`,
      },
    });
    const result = await createMediaJob(input);
    expect(result.created).toBe(false);
    expect(result.job.id).toBe(prior.id);
  });
});

// ---------------------------------------------------------------------------
// 6. An IPv6 /64 is one unit for every pre-auth bucket
// ---------------------------------------------------------------------------
describe("pass 39 — anonymous buckets normalize IPv6 to its /64", () => {
  it("puts two privacy addresses of one /64 in the same bucket", () => {
    expect(ipBucketAddress("2001:db8:1234:5678:aaaa:bbbb:cccc:dddd")).toBe(
      ipBucketAddress("2001:db8:1234:5678:1111:2222:3333:4444"),
    );
    // ...and keeps different /64s apart.
    expect(ipBucketAddress("2001:db8:1234:5678::1")).not.toBe(
      ipBucketAddress("2001:db8:1234:5679::1"),
    );
  });

  it("normalizes spelling and IPv4-mapped forms", () => {
    expect(ipBucketAddress("2001:DB8:0:0::1")).toBe(ipBucketAddress("2001:db8::2"));
    expect(ipBucketAddress("::ffff:192.0.2.1")).toBe("192.0.2.1");
    expect(ipBucketAddress("::ffff:c000:201")).toBe("192.0.2.1");
    expect(ipBucketAddress("192.0.2.1")).toBe("192.0.2.1");
    expect(ipBucketAddress("unknown")).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// 7. A password login does not disclose whether the account is OAuth-only
// ---------------------------------------------------------------------------
describe("pass 39 — password login spends the same KDF work for every account", () => {
  const authorize = (authOptions.providers[0] as unknown as {
    options: { authorize: (c: Record<string, unknown>, r: unknown) => Promise<unknown> };
  }).options.authorize;

  it("runs the dummy compare for an OAuth-created account (placeholder hash)", async () => {
    const email = `p39-oauth-${stamp}-${seq++}@test.dev`;
    await prisma.user.create({
      data: {
        email,
        passwordHash: randomBytes(32).toString("hex"),
        emailVerified: new Date(),
      },
    });
    const compare = vi.spyOn(bcrypt, "compare");
    try {
      const result = await authorize({ email, password: "anything" }, { headers: {} });
      expect(result).toBeNull();
      // Pre-fix the placeholder was handed to bcrypt.compare, which rejects it
      // in ~0 ms; the dummy hash is a real bcrypt string.
      expect(compare).toHaveBeenCalled();
      const secondArg = String(compare.mock.calls.at(-1)?.[1] ?? "");
      expect(secondArg).toMatch(/^\$2/);
    } finally {
      compare.mockRestore();
    }
  });

  it("still pays the KDF cost when the pair brake refuses the attempt", async () => {
    const email = `p39-locked-${stamp}-${seq++}@test.dev`;
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash: await bcrypt.hash("correct horse", 4),
        emailVerified: new Date(),
      },
    });
    // Trip the 10-per-(email, IP) brake (memory limiter: Redis is unset here).
    for (let i = 0; i < 10; i++) {
      const r = await reserveLoginAttempt(email, "203.0.113.9");
      expect(r.allowed).toBe(true);
    }
    expect((await reserveLoginAttempt(email, "203.0.113.9")).allowed).toBe(false);

    const compare = vi.spyOn(bcrypt, "compare");
    try {
      const result = await authorize(
        { email, password: "wrong" },
        { headers: { "x-forwarded-for": "203.0.113.9" } },
      );
      expect(result).toBeNull();
      // Pre-fix the refusal returned before touching bcrypt (~2 ms vs the
      // ~57 ms an unknown address pays), which made the 11th request an
      // existence oracle.
      expect(compare).toHaveBeenCalled();
    } finally {
      compare.mockRestore();
    }
    expect(user.id).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 8. Erasure must not claim success over files it could not delete
// ---------------------------------------------------------------------------
describe("pass 39 — erasure refuses to delete rows when a stored file survives", () => {
  it("throws 503 and keeps the account when the storage delete fails", async () => {
    const user = await makeUser("erasure-fail");
    const key = `img/p39-erasure-${stamp}-${seq++}.png`;
    await getStorage().put(key, Buffer.from("p39"), "image/png");
    await prisma.image.create({
      data: {
        userId: user.id,
        url: key,
        model: "gpt",
        quality: "medium",
        prompt: "erasure",
        credits: 8,
      },
    });
    const deleteSpy = vi
      .spyOn(getStorage(), "delete")
      .mockRejectedValueOnce(new Error("bucket unavailable"));
    let failureKeys = 0;
    try {
      await expect(
        eraseUserArtifacts(
          user.id,
          {
            lockRows: async () => undefined,
            deleteRows: async (tx) => {
              await tx.user.delete({ where: { id: user.id } });
            },
          },
          { onStorageFailure: (keys) => (failureKeys = keys.length) },
        ),
      ).rejects.toMatchObject({ status: 503 });
    } finally {
      deleteSpy.mockRestore();
    }
    // The account (and the row naming the object) is still there and retryable.
    expect(await prisma.user.findUnique({ where: { id: user.id } })).not.toBeNull();
    expect(failureKeys).toBe(1);
  });

  it("erases the user only after every object is gone", async () => {
    const user = await makeUser("erasure-ok");
    const key = `img/p39-erasure-ok-${stamp}-${seq++}.png`;
    await getStorage().put(key, Buffer.from("p39"), "image/png");
    await prisma.image.create({
      data: {
        userId: user.id,
        url: key,
        model: "gpt",
        quality: "medium",
        prompt: "erasure",
        credits: 8,
      },
    });
    await eraseUserArtifacts(user.id, {
      lockRows: async () => undefined,
      deleteRows: async (tx) => {
        await tx.user.delete({ where: { id: user.id } });
      },
    });
    expect(await prisma.user.findUnique({ where: { id: user.id } })).toBeNull();
    expect(await getStorage().get(key)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 9. Video task endpoints follow the credential's own source
// ---------------------------------------------------------------------------
describe("pass 39 — Ark/DashScope video calls are paired key+endpoint", () => {
  const saved = {
    HOME: process.env.HOME,
    ARK: process.env.ARK_IMAGE_API_KEY,
    ALIYUN: process.env.ALIYUN_API_KEY,
    DASHSCOPE: process.env.DASHSCOPE_API_KEY,
  };
  let fakeHome = "";

  beforeAll(() => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "p39-home-"));
    fs.mkdirSync(path.join(fakeHome, ".cc-proxy"), { recursive: true });
    fs.writeFileSync(
      path.join(fakeHome, ".cc-proxy", "config.json"),
      JSON.stringify({
        gateways: {
          ark: {
            api_keys: ["relay-ark-key"],
            base_url: "https://relay.example/api/coding/v1",
          },
          aliyun: {
            api_keys: ["relay-aliyun-key"],
            base_url: "https://relay.example/compatible-mode/v1",
          },
        },
      }),
    );
    process.env.HOME = fakeHome;
    delete process.env.ARK_IMAGE_API_KEY;
    delete process.env.ALIYUN_API_KEY;
    delete process.env.DASHSCOPE_API_KEY;
    _resetKeysCacheForTests();
  });

  afterAll(() => {
    process.env.HOME = saved.HOME;
    if (saved.ARK === undefined) delete process.env.ARK_IMAGE_API_KEY;
    else process.env.ARK_IMAGE_API_KEY = saved.ARK;
    if (saved.ALIYUN === undefined) delete process.env.ALIYUN_API_KEY;
    else process.env.ALIYUN_API_KEY = saved.ALIYUN;
    if (saved.DASHSCOPE === undefined) delete process.env.DASHSCOPE_API_KEY;
    else process.env.DASHSCOPE_API_KEY = saved.DASHSCOPE;
    _resetKeysCacheForTests();
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  it("keeps a gateway credential on the gateway's origin", () => {
    // Pre-fix: getArkKey() returned the relay key while the create/poll URL was
    // hardcoded to ark.cn-beijing.volces.com — the relay credential travelled to
    // Volcengine, and the relay's task could never be polled.
    expect(getArkVideoConfig()).toEqual({
      key: "relay-ark-key",
      tasksUrl: "https://relay.example/api/v3/contents/generations/tasks",
    });
    expect(getAliyunTaskUrl("task-1")).toBe("https://relay.example/api/v1/tasks/task-1");
  });

  it("sends an env credential to the vendor's own host", () => {
    process.env.ARK_IMAGE_API_KEY = "env-ark-key";
    process.env.DASHSCOPE_API_KEY = "env-dash-key";
    _resetKeysCacheForTests();
    expect(getArkVideoConfig()).toEqual({
      key: "env-ark-key",
      tasksUrl: "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks",
    });
    expect(getAliyunTaskUrl("task-2")).toBe("https://dashscope.aliyuncs.com/api/v1/tasks/task-2");
  });
});

// ---------------------------------------------------------------------------
// 10. A partial dispute/refund must not revoke the whole order
// ---------------------------------------------------------------------------
describe("pass 39 — a measured refund revokes only when it covers the price", () => {
  it("keeps credits and the paid status for a partial dispute, then revokes at the price", async () => {
    const user = await makeUser("partial-dispute");
    const order = await prisma.order.create({
      data: {
        userId: user.id,
        kind: "pack",
        status: "paid",
        amountUsd: 49.99,
        credits: 6000,
        provider: "mock",
        idempotencyKey: `p39-dispute-${stamp}-${seq++}`,
      },
    });
    await prisma.$transaction((tx) =>
      grantCreditsTx(tx, user.id, "PURCHASE", 6000, null, "order", order.id),
    );
    const { POST } = await import("../app/api/webhooks/payment/route");
    const send = (eventId: string, refundAmountUsd: number) =>
      POST(
        new Request("http://localhost/api/webhooks/payment", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ eventId, status: "refunded", orderId: order.id, refundAmountUsd }),
        }),
      );

    // Pre-fix a Stripe dispute was mapped to fullRefund:true regardless of its
    // amount, so this $1 partial wiped all 6000 credits.
    expect((await send(`p39-dispute-a-${stamp}`, 1)).status).toBe(200);
    let after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe("paid");
    expect(after.refundedAmountUsd).toBe(1);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).credits).toBe(6000);

    // A second distinct delivery covering the rest promotes to full.
    expect((await send(`p39-dispute-b-${stamp}`, 48.99)).status).toBe(200);
    after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe("refunded");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).credits).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 11. Middleware buckets: per credential for Bearer, per endpoint for anonymous
// ---------------------------------------------------------------------------
describe("pass 39 — middleware buckets follow the credential and the endpoint", () => {
  const prev = process.env.MIDDLEWARE_API_LIMIT;
  beforeAll(() => {
    process.env.MIDDLEWARE_API_LIMIT = "2";
  });
  afterAll(() => {
    if (prev === undefined) delete process.env.MIDDLEWARE_API_LIMIT;
    else process.env.MIDDLEWARE_API_LIMIT = prev;
  });

  function req(path: string, ip: string, token?: string) {
    const headers: Record<string, string> = { "x-forwarded-for": ip };
    if (token) headers.authorization = `Bearer ${token}`;
    return new NextRequest(`http://localhost${path}`, { headers });
  }

  it("does not let one Bearer key's burst refuse another key on the same IP", async () => {
    const ip = "198.51.100.31";
    const a = "pd_live_aaaaaaaaaaaaaaaaaaaa";
    const b = "pd_live_bbbbbbbbbbbbbbbbbbbb";
    expect((await proxy(req("/api/jobs", ip, a))).status).toBe(200);
    expect((await proxy(req("/api/jobs", ip, a))).status).toBe(200);
    expect((await proxy(req("/api/jobs", ip, a))).status).toBe(429);
    // Pre-fix this shared `ip:<addr>:api` with the exhausted key → 429.
    expect((await proxy(req("/api/jobs", ip, b))).status).toBe(200);
  });

  it("does not let an anonymous health loop refuse registration", async () => {
    const ip = "198.51.100.32";
    expect((await proxy(req("/api/health", ip))).status).toBe(200);
    expect((await proxy(req("/api/health", ip))).status).toBe(200);
    expect((await proxy(req("/api/health", ip))).status).toBe(429);
    // A different anonymous endpoint has its own bucket (pre-fix: 429).
    expect((await proxy(req("/api/register", ip))).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 12. Local storage objects are owner-only; 429s carry the documented headers
// ---------------------------------------------------------------------------
describe("pass 39 — local media is owner-only", () => {
  it("creates files 0600 and directories 0700", async () => {
    const key = `img/p39-mode-${stamp}-${seq++}.png`;
    await getStorage().put(key, Buffer.from("p39"), "image/png");
    const file = path.join(STORAGE_DIR, key);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
  });
});

describe("pass 39 — account-keyed 429s carry the documented RateLimit headers", () => {
  it("sets RateLimit-Limit / Remaining next to Retry-After", async () => {
    const userId = `p39-rate-${stamp}`;
    expect(await enforceUserRateLimit(userId, "p39", 1, 60_000)).toBeNull();
    const err = await enforceUserRateLimit(userId, "p39", 1, 60_000);
    expect(err).not.toBeNull();
    const res = fail(err);
    expect(res.status).toBe(429);
    expect(res.headers.get("RateLimit-Limit")).toBe("1");
    expect(res.headers.get("RateLimit-Remaining")).toBe("0");
    expect(res.headers.get("Retry-After")).toBeTruthy();
  });
});

describe("pass 39 — a malformed REDIS_URL degrades to the memory limiter", () => {
  it("does not throw from the limiter constructor", async () => {
    const prev = process.env.REDIS_URL;
    process.env.REDIS_URL = "redis://127.0.0.1:notaport";
    _resetLimiterForTests();
    try {
      const r = await rateLimit(`p39-redis-${stamp}`, 1, 1_000);
      expect(r.ok).toBe(true);
    } finally {
      _resetLimiterForTests();
      if (prev === undefined) delete process.env.REDIS_URL;
      else process.env.REDIS_URL = prev;
    }
  });
});
