import { afterAll, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// Pass 53.
//
//   - next-auth names its state-bearing cookies `__Secure-*`, which still
//     accepts a Domain attribute: a hostile sibling subdomain could plant a
//     session cookie (or a copied OAuth state/PKCE pair) for the parent domain
//     and win the duplicate-name race — login CSRF, or a session fixed to the
//     attacker's account. Production now issues `__Host-` names, which the
//     browser refuses to accept with a Domain.
//   - The payment webhook secret was only checked for EXISTENCE. The value
//     published in this repository (`whsec_test`, scripts/test-webhook.ts's old
//     default) booted a production deployment clean, and anyone who has read
//     the repo could then forge a paid webhook for a pending order.
//   - The moderation-refusal budget compared DB-stamped Job.createdAt against
//     the app's Date.now(); a web clock ahead by a day counted zero refusals and
//     reopened the provider-spend loop the budget closes.
//   - Gallery delete removed the Image row FIRST and the blob best-effort. The
//     row is the only record naming the key, so a failed object delete orphaned
//     the user's image beyond even account erasure.
//   - reclaimStoredArtifact filters Image by jobId, which had no index: a
//     sequential scan on every failed-job cleanup / superseded clip.

const getServerSession = vi.fn();
vi.mock("next-auth", () => ({
  getServerSession: (...args: unknown[]) => getServerSession(...args),
}));

// Real local objects in a scratch tree, and no shared Redis (in-process
// limiter), matching tests/pass24-hardening.test.ts.
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pd-p53-"));
process.env.LOCAL_STORAGE_DIR = storageRoot;
process.env.NEXTAUTH_URL = "https://pixelduo.test";
delete process.env.REDIS_URL;

const { prisma } = await import("../lib/prisma");
const { getStorage } = await import("../lib/storage");
const { assertProductionConfig } = await import("../instrumentation");
const { authCookies, secureAuthCookies, sessionCookieNames } = await import("../lib/auth-cookies");
const { moderationRefusalBudget, MODERATION_REFUSAL_MESSAGE } = await import("../lib/safety");
const { DELETE: deleteGallery } = await import("../app/api/gallery/route");

const tag = `pass53-${Date.now()}`;
const madeUsers: string[] = [];

async function makeUser(label: string): Promise<string> {
  const user = await prisma.user.create({
    data: {
      email: `${tag}-${label}-${madeUsers.length}@test.dev`,
      passwordHash: "x",
      name: "Pass 53",
      emailVerified: new Date(),
    },
  });
  madeUsers.push(user.id);
  return user.id;
}

afterAll(async () => {
  await prisma.job.deleteMany({ where: { userId: { in: madeUsers } } });
  await prisma.image.deleteMany({ where: { userId: { in: madeUsers } } });
  await prisma.user.deleteMany({ where: { id: { in: madeUsers } } });
  await prisma.$disconnect();
  fs.rmSync(storageRoot, { recursive: true, force: true });
});

describe("auth cookies are host-only in production", () => {
  it("issues __Host- names with no Domain attribute", () => {
    expect(secureAuthCookies()).toBe(true);
    const cookies = authCookies();
    for (const key of ["sessionToken", "callbackUrl", "pkceCodeVerifier", "state", "nonce"] as const) {
      const cookie = cookies[key];
      expect(cookie.name.startsWith("__Host-")).toBe(true);
      expect(cookie.options.path).toBe("/");
      expect(cookie.options.secure).toBe(true);
      expect((cookie.options as { domain?: string }).domain).toBeUndefined();
    }
    // The proxy keys per-credential buckets on the same spelling the auth
    // routes mint; a second spelling must not silently fall back to the IP
    // bucket.
    expect(sessionCookieNames()).toContain(cookies.sessionToken.name);
  });

  it("keeps next-auth's plain names on an http development origin", async () => {
    process.env.NEXTAUTH_URL = "http://localhost:3000";
    vi.resetModules();
    const dev = await import("../lib/auth-cookies");
    const cookies = dev.authCookies();
    expect(cookies.sessionToken.name).toBe("next-auth.session-token");
    expect(cookies.sessionToken.options.secure).toBe(false);
    process.env.NEXTAUTH_URL = "https://pixelduo.test";
  });
});

describe("published webhook secrets cannot boot production", () => {
  const base: NodeJS.ProcessEnv = {
    NODE_ENV: "production",
    NEXTAUTH_SECRET: "9f2c7a51e8d34b60c1a7f928d5e63b40",
    NEXTAUTH_URL: "https://pixelduo.test",
    SMTP_URL: "smtp://mail.pixelduo.test:587",
  };

  it("refuses the repository's own test value", () => {
    expect(() =>
      assertProductionConfig({ ...base, PAYMENT_PROVIDER: "stripe", STRIPE_WEBHOOK_SECRET: "whsec_test" }),
    ).toThrow(/STRIPE_WEBHOOK_SECRET/);
    // Whitespace/case carried out of a YAML/env file must not dodge the check.
    expect(() =>
      assertProductionConfig({ ...base, PAYMENT_PROVIDER: "stripe", STRIPE_WEBHOOK_SECRET: " WHSEC_TEST " }),
    ).toThrow(/STRIPE_WEBHOOK_SECRET/);
  });

  it("refuses placeholders and unusably short values", () => {
    expect(() =>
      assertProductionConfig({ ...base, PAYMENT_PROVIDER: "paddle", PADDLE_WEBHOOK_SECRET: "pdl_ntfset_test" }),
    ).toThrow(/PADDLE_WEBHOOK_SECRET/);
    expect(() =>
      assertProductionConfig({ ...base, PAYMENT_PROVIDER: "stripe", STRIPE_WEBHOOK_SECRET: "whsec_1234" }),
    ).toThrow(/STRIPE_WEBHOOK_SECRET/);
  });

  it("accepts a real-length provider secret", () => {
    expect(() =>
      assertProductionConfig({
        ...base,
        PAYMENT_PROVIDER: "stripe",
        STRIPE_WEBHOOK_SECRET: "whsec_5f2c7a51e8d34b60c1a7f928d5e63b40",
      }),
    ).not.toThrow();
  });

  it("still allows a declared test deployment", () => {
    expect(() =>
      assertProductionConfig({
        ...base,
        PAYMENT_PROVIDER: "mock",
        PAYMENT_ALLOW_MOCK: "1",
        STRIPE_WEBHOOK_SECRET: "whsec_test",
      }),
    ).not.toThrow();
  });
});

describe("the moderation budget uses the database clock", () => {
  it("still counts a refusal when the app clock is a day ahead", async () => {
    const userId = await makeUser("clock");
    await prisma.job.create({
      data: {
        userId,
        status: "failed",
        model: "gpt",
        prompt: "pass53",
        costCredits: 10,
        images: "[]",
        error: MODERATION_REFUSAL_MESSAGE,
        createdAt: new Date(),
      },
    });

    // Only Date is faked: Prisma still needs real timers to complete the query.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(Date.now() + 48 * 3600_000));
      const budget = await moderationRefusalBudget(userId);
      // Pre-fix the cutoff was app-now minus 24h, i.e. a day in the future, so
      // the row was filtered out and this read 0.
      expect(budget.refused).toBe(1);
      expect(budget.ok).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("gallery delete keeps the row when the object cannot be removed", () => {
  async function makeImage(userId: string, key: string): Promise<string> {
    await getStorage().put(key, Buffer.from("image-bytes"), "image/png");
    const image = await prisma.image.create({
      data: { userId, url: key, model: "gpt", quality: "medium", prompt: "pass53", credits: 1 },
    });
    return image.id;
  }

  function request(ids: string[]) {
    return new Request("http://localhost:3100/api/gallery", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids }),
    });
  }

  it("deletes the object before the row", async () => {
    const userId = await makeUser("gallery-ok");
    getServerSession.mockResolvedValue({ user: { id: userId, sv: 0 } });
    const key = `img/${tag}-ok.png`;
    const imageId = await makeImage(userId, key);

    const res = await deleteGallery(request([imageId]));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted: number; keptIds: string[] };
    expect(body.deleted).toBe(1);
    expect(body.keptIds).toEqual([]);
    expect(await prisma.image.count({ where: { id: imageId } })).toBe(0);
    expect(await getStorage().size(key)).toBeNull();
  });

  it("keeps the row when the storage delete fails, so erasure can still find it", async () => {
    const userId = await makeUser("gallery-fail");
    getServerSession.mockResolvedValue({ user: { id: userId, sv: 0 } });
    const key = `img/${tag}-fail.png`;
    const imageId = await makeImage(userId, key);

    const storage = getStorage();
    const spy = vi.spyOn(storage, "delete").mockRejectedValueOnce(new Error("storage down"));
    try {
      const res = await deleteGallery(request([imageId]));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { deleted: number; keptIds: string[] };
      expect(body.deleted).toBe(0);
      expect(body.keptIds).toEqual([imageId]);
    } finally {
      spy.mockRestore();
    }

    // The row is still the pointer account erasure reads, and the object is
    // still there to be removed by the retry.
    expect(await prisma.image.count({ where: { id: imageId } })).toBe(1);
    expect(await getStorage().size(key)).not.toBeNull();
  });
});

describe("artifact reclaim has an index to use", () => {
  it("migrates Image.jobId into pg_indexes", async () => {
    const rows = await prisma.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname FROM pg_indexes WHERE tablename = 'Image'
    `;
    expect(rows.map((r) => r.indexname)).toContain("Image_jobId_idx");
  });
});
