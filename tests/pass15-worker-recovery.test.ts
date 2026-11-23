import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { prisma } from "../lib/prisma";
import { checkpointKeys, createMediaJob } from "../lib/queue";
import { grantCreditsTx, fulfillOrder } from "../lib/ledger";
import { _resetStorageForTests, getStorage } from "../lib/storage";
import { isFreeTier, processImageJob, processVideoJob } from "../scripts/worker";

// Pass-15 recovery tests for the worker's delivery paths. Each block pins a
// failure that charged or under-delivered in production-looking conditions:
//
//  - B3: the paid tier did not self-expire, so unwatermarked output outlived
//        the subscription until the daily rollover sweep (or forever without
//        it).
//  - B4: a "both" job checkpointed nothing, so a failure AFTER generation left
//        its 2N objects referenced by nothing.
//  - D3: the extend path treated "segment read failed" like "source missing"
//        and delivered (and charged for) a URL that 404s.
//
// The worker's step functions are driven directly — that is the unit a claim
// leaves behind — with the provider lanes stubbed the way
// tests/provider-both-count.test.ts stubs them (the real dispatcher, not
// MOCK_IMAGE_PROVIDER, which short-circuits the "both" branch) for image work,
// and with the mock provider for video work.

let seq = 0;

// 120² is large enough for bakeWatermark to composite its badge (the helper
// passes anything shorter than fontSize + padding through untouched, which is
// what the 1×1 mock stubs are).
const IMAGE_SIDE = 120;
let providerPng: Buffer;

interface ProviderCall {
  url: string;
  body: Record<string, unknown>;
}
let calls: ProviderCall[] = [];

const origFetch = globalThis.fetch;
const origEnv = {
  MOCK: process.env.MOCK_IMAGE_PROVIDER,
  MODELVERSE: process.env.MODELVERSE_IMAGE_API_KEY,
  ARK: process.env.ARK_IMAGE_API_KEY,
  MODERATION: process.env.IMAGE_MODERATION,
  NSFW: process.env.IMAGE_NSFW_ENDPOINT,
};

async function makeUser(tag: string, credits: number) {
  const user = await prisma.user.create({
    data: { email: `p15-${tag}-${Date.now()}-${seq++}@test.dev`, passwordHash: "x", name: tag },
  });
  if (credits > 0) {
    await prisma.$transaction((tx) => grantCreditsTx(tx, user.id, "SIGNUP_BONUS", credits, null));
  }
  return user;
}

// A user funded by a real (mock-paid) plan order, so the job's pre-auth
// consumption names a grant with order provenance — that is what completeJob's
// refunded-order gate reads.
async function makePlanUser(tag: string, credits: number) {
  const user = await prisma.user.create({
    data: { email: `p15-${tag}-${Date.now()}-${seq++}@test.dev`, passwordHash: "x", name: tag },
  });
  const order = await prisma.order.create({
    data: {
      userId: user.id,
      kind: "plan",
      provider: "mock",
      amountUsd: 19,
      credits,
      planId: "pro",
      idempotencyKey: `p15-order-${Date.now()}-${seq++}`,
    },
  });
  await fulfillOrder(user.id, order.id, "plan", credits, "pro");
  return { user, order };
}

// What a claim does to the row before the worker step runs: processImageJob /
// processVideoJob rely on an in-flight status for every CAS write they make
// (checkpointJobProgress, completeJob).
async function claimed(jobId: string) {
  return prisma.job.update({
    where: { id: jobId },
    data: { status: "running", worker: "p15-test-worker" },
  });
}

// A horizontal band of an encoded image as raw RGB, so two renders can be
// compared pixel for pixel.
async function band(buf: Buffer, top: number, height: number): Promise<Buffer> {
  return sharp(buf).extract({ left: 0, top, width: IMAGE_SIDE, height }).removeAlpha().raw().toBuffer();
}

beforeAll(async () => {
  providerPng = await sharp({
    create: { width: IMAGE_SIDE, height: IMAGE_SIDE, channels: 3, background: { r: 10, g: 60, b: 120 } },
  })
    .png()
    .toBuffer();
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    return new Response(JSON.stringify({ data: [{ b64_json: providerPng.toString("base64") }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  globalThis.fetch = origFetch;
  for (const [key, value] of [
    ["MOCK_IMAGE_PROVIDER", origEnv.MOCK],
    ["MODELVERSE_IMAGE_API_KEY", origEnv.MODELVERSE],
    ["ARK_IMAGE_API_KEY", origEnv.ARK],
    ["IMAGE_MODERATION", origEnv.MODERATION],
    ["IMAGE_NSFW_ENDPOINT", origEnv.NSFW],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await prisma.user.deleteMany({ where: { email: { startsWith: "p15-" } } });
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// P15-B3 — the paid tier must expire where it is consumed
// ---------------------------------------------------------------------------
describe("plan entitlement expires where the watermark is decided", () => {
  beforeAll(() => {
    // Drive the REAL dispatcher: MOCK_IMAGE_PROVIDER short-circuits
    // generateImages and would never reach the lanes under test.
    delete process.env.MOCK_IMAGE_PROVIDER;
    process.env.MODELVERSE_IMAGE_API_KEY = "test-key";
    process.env.ARK_IMAGE_API_KEY = "test-key";
    // A moderation audit is not part of this test, and an ambient setting would
    // turn every job into a refunded failure.
    delete process.env.IMAGE_MODERATION;
    delete process.env.IMAGE_NSFW_ENDPOINT;
  });

  it("reads the tier from planRenewsAt, not from the plan name", () => {
    // The decision clock is required (pass 68): the worker always hands it the
    // database's now, so these pure cases pin the same instant.
    const now = new Date();
    expect(isFreeTier(null, now)).toBe(true);
    expect(isFreeTier({ plan: "free", planRenewsAt: null }, now)).toBe(true);
    // Lapsed cycle, sweep not run yet: the entitlement ended with the cycle.
    expect(isFreeTier({ plan: "pro", planRenewsAt: new Date(now.getTime() - 1_000) }, now)).toBe(true);
    // A paid plan with no cycle end proves nothing, so it is not trusted.
    expect(isFreeTier({ plan: "pro", planRenewsAt: null }, now)).toBe(true);
    // In cycle: unchanged.
    expect(isFreeTier({ plan: "pro", planRenewsAt: new Date(now.getTime() + 86_400_000) }, now)).toBe(false);
  });

  it("bakes the badge into a lapsed plan's deliverable and delivers clean bytes in cycle", async () => {
    const lapsed = await makeUser("wm-lapsed", 200);
    await prisma.user.update({
      where: { id: lapsed.id },
      data: { plan: "pro", planRenewsAt: new Date(Date.now() - 60_000) },
    });
    const { job: lapsedJob } = await createMediaJob({
      userId: lapsed.id,
      model: "gpt",
      mediaType: "image",
      quality: "medium",
      count: 1,
      prompt: "a lighthouse at dusk",
    });
    await processImageJob(await claimed(lapsedJob.id), "p15-test-worker");

    const lapsedRow = await prisma.image.findFirstOrThrow({ where: { jobId: lapsedJob.id } });
    const delivered = await getStorage().get(lapsedRow.url);
    expect(delivered).not.toBeNull();
    const meta = await sharp(delivered!).metadata();
    expect(meta.format).toBe("png");
    expect(meta.width).toBe(IMAGE_SIDE);
    expect(meta.height).toBe(IMAGE_SIDE);
    // The badge is composited along the bottom edge and touches nothing else:
    // the top band is pixel-identical to the provider's output, the bottom band
    // is not (a rounded-corner rect, so the exact corner pixel would be a false
    // negative). Compare bands rather than bytes — both are PNGs of the same
    // dimensions and the encoder is free to differ where nothing changed.
    expect((await band(delivered!, 0, 20)).equals(await band(providerPng, 0, 20))).toBe(true);
    expect(
      (await band(delivered!, IMAGE_SIDE - 20, 20)).equals(await band(providerPng, IMAGE_SIDE - 20, 20)),
    ).toBe(false);

    // In cycle the deliverable is byte-identical to the provider's output —
    // "do not change what a live plan does".
    const active = await makeUser("wm-active", 200);
    await prisma.user.update({
      where: { id: active.id },
      data: { plan: "pro", planRenewsAt: new Date(Date.now() + 86_400_000) },
    });
    const { job: activeJob } = await createMediaJob({
      userId: active.id,
      model: "gpt",
      mediaType: "image",
      quality: "medium",
      count: 1,
      prompt: "a lighthouse at dawn",
    });
    await processImageJob(await claimed(activeJob.id), "p15-test-worker");

    const activeRow = await prisma.image.findFirstOrThrow({ where: { jobId: activeJob.id } });
    const clean = await getStorage().get(activeRow.url);
    expect(clean).not.toBeNull();
    expect(clean!.equals(providerPng)).toBe(true);
  });

  it("does not badge an image a previous attempt already badged", async () => {
    // The bake loop ran over every image of the job on every attempt, and a retry
    // resumes from the checkpoint written BEFORE the bake — so a failure after
    // the bake (a storage put, a Prisma error inside completeJob's transaction,
    // the worker killed and recoverStuckJobs requeueing it) composited the badge
    // onto the badge. Measured before the fix: the 0.55-alpha badge reached ~0.80
    // and the band's mean |Δ| was 42/255; and because bakeWatermark now preserves
    // the container it was handed, the second pass also re-encoded an
    // already-lossy file over its only copy.
    const user = await makeUser("wm-rebake", 200); // free tier: the badge applies
    const { job } = await createMediaJob({
      userId: user.id,
      model: "gpt",
      mediaType: "image",
      quality: "medium",
      count: 1,
      prompt: "a cat on a windowsill",
    });
    await processImageJob(await claimed(job.id), "p15-test-worker");
    const row = await prisma.image.findFirstOrThrow({ where: { jobId: job.id } });
    const baked = await getStorage().get(row.url);
    expect(baked).not.toBeNull();

    // The state a retry finds: the job is back in flight with the checkpoint it
    // left behind, and that checkpoint says this key is already badged — which is
    // exactly what the worker now writes after baking.
    await prisma.job.update({
      where: { id: job.id },
      data: {
        status: "running",
        attempts: 1,
        images: JSON.stringify([{ key: row.url, model: "gpt", baked: true }]),
      },
    });
    await processImageJob(await claimed(job.id), "p15-test-worker");

    const again = await getStorage().get(row.url);
    expect(again).not.toBeNull();
    expect(again!.equals(baked!)).toBe(true);
  });

  it("flips the provider-side mark for the same two tiers (Ark watermark param)", async () => {
    // Provider-side marks (Seedream's baked-in "AI生成") are the other half of
    // the same decision, so the lapsed plan must not keep that either.
    const lapsed = await makeUser("wm-ark-lapsed", 200);
    await prisma.user.update({
      where: { id: lapsed.id },
      data: { plan: "pro", planRenewsAt: new Date(Date.now() - 60_000) },
    });
    const { job: lapsedJob } = await createMediaJob({
      userId: lapsed.id,
      model: "seedream",
      mediaType: "image",
      quality: "standard",
      count: 1,
      prompt: "a red kite",
    });
    calls = [];
    await processImageJob(await claimed(lapsedJob.id), "p15-test-worker");
    expect(calls).toHaveLength(1);
    expect(calls[0].body.model).toBe("doubao-seedream-5-0-260128");
    expect(calls[0].body.watermark).toBe(true);

    const active = await makeUser("wm-ark-active", 200);
    await prisma.user.update({
      where: { id: active.id },
      data: { plan: "studio", planRenewsAt: new Date(Date.now() + 86_400_000) },
    });
    const { job: activeJob } = await createMediaJob({
      userId: active.id,
      model: "seedream",
      mediaType: "image",
      quality: "standard",
      count: 1,
      prompt: "a blue kite",
    });
    calls = [];
    await processImageJob(await claimed(activeJob.id), "p15-test-worker");
    expect(calls).toHaveLength(1);
    expect(calls[0].body.watermark).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// P15-B4 — a failed "both" job's objects must be reclaimable
// ---------------------------------------------------------------------------
describe("a failed both-lane job reclaims everything it stored", () => {
  beforeAll(() => {
    delete process.env.MOCK_IMAGE_PROVIDER;
    process.env.MODELVERSE_IMAGE_API_KEY = "test-key";
    process.env.ARK_IMAGE_API_KEY = "test-key";
    delete process.env.IMAGE_MODERATION;
    delete process.env.IMAGE_NSFW_ENDPOINT;
  });

  it("deletes both lanes' objects when delivery is refused after generation", async () => {
    const { user, order } = await makePlanUser("both-refund", 2000);
    const { job } = await createMediaJob({
      userId: user.id,
      model: "both",
      mediaType: "image",
      quality: "medium",
      count: 1,
      prompt: "a lighthouse in a storm",
      maxAttempts: 1,
    });
    calls = [];

    // The reachable trigger: the funding order is refunded while the job is in
    // flight, so completeJob refuses delivery at the single delivery point.
    await prisma.order.update({ where: { id: order.id }, data: { status: "refunded" } });
    await processImageJob(await claimed(job.id), "p15-test-worker");

    const failed = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("job-cancelled-refunded-order");
    // Nothing was delivered, so nothing was charged for.
    expect(await prisma.image.count({ where: { jobId: job.id } })).toBe(0);
    // Both billed lanes ran, one call each (asserted on the hard-coded upstream
    // model ids rather than the URLs, which can legitimately be gateway hosts).
    expect(calls.map((c) => c.body.model).sort()).toEqual(["doubao-seedream-5-0-260128", "gpt-image-2"]);
    // …and both objects it stored are named by the checkpoint the failure path
    // reclaims, because the lanes cannot checkpoint while they run in parallel.
    const keys = checkpointKeys(failed.images);
    expect(keys).toHaveLength(2);
    for (const key of keys) {
      expect(await getStorage().get(key)).toBeNull();
    }
  });

  it("resumes a retried both job from the merged checkpoint instead of regenerating it", async () => {
    const user = await makeUser("both-retry", 200);
    const { job } = await createMediaJob({
      userId: user.id,
      model: "both",
      mediaType: "image",
      quality: "medium",
      count: 1,
      prompt: "a lighthouse at midnight",
      maxAttempts: 3,
    });
    await claimed(job.id);
    // Fail the attempt a moment AFTER generation, with a transient error: the
    // free-tier watermark pass reads each object back, so making that read fail
    // leaves the job requeued rather than terminally refunded — the retry case
    // the checkpoint exists for.
    const storage = getStorage();
    vi.spyOn(storage, "get").mockImplementation(async () => null);
    calls = [];
    await processImageJob(await prisma.job.findUniqueOrThrow({ where: { id: job.id } }), "p15-test-worker");
    vi.restoreAllMocks();

    const retried = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(retried.status).toBe("queued");
    expect(retried.attempts).toBe(1);
    const keys = checkpointKeys(retried.images);
    expect(keys).toHaveLength(2);
    // Kept, not reclaimed: the next attempt resumes from them instead of
    // calling both billed lanes again.
    _resetStorageForTests();
    for (const key of keys) {
      expect(await getStorage().get(key)).not.toBeNull();
    }

    calls = [];
    await processImageJob(await claimed(job.id), "p15-test-worker");
    expect(calls).toHaveLength(0); // nothing regenerated, nothing re-billed
    const finished = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(finished.status).toBe("done");
    expect(await prisma.image.count({ where: { jobId: job.id } })).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// P15-D3 — extend delivery must not ship a segment it failed to read
// ---------------------------------------------------------------------------
describe("extend delivery", () => {
  beforeEach(() => {
    process.env.MOCK_IMAGE_PROVIDER = "1";
  });

  afterEach(() => {
    delete process.env.MOCK_IMAGE_PROVIDER;
  });

  async function makeExtendJob(tag: string) {
    const user = await makeUser(tag, 1000);
    const sourceKey = `img/p15-source-${Date.now()}-${seq++}.mp4`;
    await getStorage().put(sourceKey, Buffer.from("source-video"), "video/mp4");
    const { job } = await createMediaJob({
      userId: user.id,
      model: "seedance",
      mediaType: "video",
      quality: "standard",
      count: 1,
      prompt: "continue the shot",
      durationSec: 5,
      sourceVideoKey: sourceKey,
    });
    // Phase 1 already ran in a previous claim: the provider task exists, so the
    // worker goes straight to polling and downloading.
    await prisma.job.update({
      where: { id: job.id },
      data: { status: "running", providerTaskId: "task-p15", worker: "p15-test-worker" },
    });
    return { job, sourceKey };
  }

  it("fails transiently when the stored segment cannot be read back", async () => {
    const { job, sourceKey } = await makeExtendJob("ext-segment");
    const storage = getStorage();
    const origGet = storage.get.bind(storage);
    const reads: string[] = [];
    // Every read of the just-stored segment fails; the source is untouched, so
    // the case under test is a storage fault on the SEGMENT, not a missing
    // source.
    vi.spyOn(storage, "get").mockImplementation(async (key: string) => {
      reads.push(key);
      return key === sourceKey ? origGet(key) : null;
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await processVideoJob(await prisma.job.findUniqueOrThrow({ where: { id: job.id } }), "p15-test-worker");

    const after = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    // Not "done": delivering here charged the video in full for a URL that
    // 404s. Not "failed" either — the segment is recoverable, so the job is
    // requeued with backoff and the checkpoint still names it.
    expect(after.status).toBe("queued");
    expect(after.attempts).toBe(1);
    expect(after.error).toMatch(/segment-missing/);
    expect(errors.mock.calls.flat().join(" ")).toContain("segment-missing");
    expect(await prisma.image.count({ where: { jobId: job.id } })).toBe(0);

    const keys = checkpointKeys(after.images);
    expect(keys).toHaveLength(1);
    expect(reads).toContain(keys[0]);
    _resetStorageForTests();
    expect(await getStorage().get(keys[0])).not.toBeNull();

    // And the retry really does recover it: a fresh claim polls the same task,
    // re-downloads the segment, and delivers that (the checkpointed original is
    // superseded) rather than a key nothing can read.
    await processVideoJob(await claimed(job.id), "p15-test-worker");
    const done = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(done.status).toBe("done");
    const delivered = await prisma.image.findFirstOrThrow({ where: { jobId: job.id } });
    _resetStorageForTests();
    expect(await getStorage().get(delivered.url)).not.toBeNull();
  });

  it("still delivers the segment alone when only the SOURCE is missing", async () => {
    const { job, sourceKey } = await makeExtendJob("ext-source");
    const storage = getStorage();
    const origGet = storage.get.bind(storage);
    // Only the source read fails now: the segment (what the provider billed
    // for) is intact, so a delivery beats a refund — the pre-existing product
    // decision this fix must not change.
    vi.spyOn(storage, "get").mockImplementation(async (key: string) => (key === sourceKey ? null : origGet(key)));
    const warns = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const claimedJob = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    await processVideoJob(claimedJob, "p15-test-worker");

    const done = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(done.status).toBe("done");
    // The two branches must stay distinguishable in the logs.
    const logged = warns.mock.calls.flat().join(" ");
    expect(logged).toContain("source video missing");
    expect(logged).not.toContain("segment-missing");

    const delivered = await prisma.image.findFirstOrThrow({ where: { jobId: job.id } });
    _resetStorageForTests();
    expect(await getStorage().get(delivered.url)).not.toBeNull();
  });
});
