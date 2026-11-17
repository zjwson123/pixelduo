import { afterAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";
import { readFileSync } from "fs";
import path from "path";

// Pass 62. The five domain audits found no P1; these are the verified fixes.
//
//   1. The SSRF blocklist missed Azure's WireServer front end (168.63.129.16,
//      which answers on :80) and the deprecated IPv4-translated IPv6 form
//      `::ffff:0:a9fe:a9fe` (WHATWG's normalisation of
//      `[::ffff:0:169.254.169.254]`). A compromised provider/gateway could have
//      the worker fetch guest-agent metadata and store it as the owner's video.
//   2. The prompt word list was defeated by an INVISIBLE character inside the
//      word: `nud\u0001e`, `nud\u2800e`, `nud\u{1F3FB}e` all passed.
//   3. MOCK_IMAGE_PROVIDER=1 accepted PAYMENT_ALLOW_MOCK=1 alone while the
//      deployment took real money — stub images for real credits.
//   4. A mock test deployment on a PUBLIC http:// origin could mint unprefixed,
//      non-Secure auth cookies (the pass-53 sibling-subdomain fixation); the
//      boot gate skipped the https requirement for every testDeployment.
//   5. The CreditReminder cron read the user then inserted in a separate
//      statement: an erasure committing in that gap left a permanent reminder
//      row (no FK) and mailed the erased address.
//   6. Admin writes authorized only at handler entry could commit after a
//      concurrent demotion/erasure/revocation, leaving the operator's id on
//      rows the erasure scrub had already passed.
//   7. cycleUsageTx materialised every Job row since the cycle grant and
//      filtered `consumption` in JS — memory/time inside the payment webhook's
//      transaction at the cycle sizes pass 18 already had to survive.
//   8. revoke-sessions and both erasure routes matched VerificationToken by
//      userId only; nullable legacy rows (userId = null) survived them.
//   9. The env IP bucket key was `${scope}:${ip}`, so a client-chosen
//      X-Forwarded-For of `notify-global` collided with the feedback
//      notification ceiling's own key on a direct-to-app deployment.
//  10. refuseNulDeep silently stopped at depth 32 instead of refusing, leaving
//      a deep NUL/lone surrogate unchecked.
//  11. /api/files let a percent-encoded leading slash match a Template.img
//      stored as `/templates/…` while the storage driver read a different key.
//  12. `npm run db:seed` deleted every Template row (imported cases included);
//      fixed /tmp paths in two scripts followed symlinks; the local compose's
//      bucket initialiser failed on a second `up` (stopping the backup loop);
//      Caddy kept Docker's default capabilities.

const { prisma } = await import("../lib/prisma");
const { hostIsPublic } = await import("../lib/store");
const { checkPrompt } = await import("../lib/safety");
const { parseJsonBody, enforceRateLimit } = await import("../lib/api");
const { rateLimit, _resetLimiterForTests } = await import("../lib/rate-limit");
const { mockImageProviderEnabled } = await import("../lib/providers/index");
const { assertProductionConfig, isLocalOrPrivateHostname } = await import("../instrumentation");
const { assertAdminActorTx } = await import("../lib/admin");
const { cycleUsage, consumesGrant } = await import("../lib/ledger");
const { sendExpiryReminders } = await import("../lib/reminder");
const { GET: filesGet } = await import("../app/api/files/[...key]/route");

const REPO = process.cwd();
let seq = 0;
const tag = `pass62-${Date.now()}`;

async function makeUser(extra: Record<string, unknown> = {}) {
  return prisma.user.create({
    data: {
      email: `${tag}-${seq++}@test.dev`,
      passwordHash: bcrypt.hashSync("pass62-password", 4),
      name: "Pass 62",
      ...extra,
    },
  });
}

const SECRET = "9f2b7c1d4e8a6305f1c9d2b7a4e86031";

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { startsWith: tag } } }).catch(() => undefined);
});

describe("pass 62 — SSRF literals the blocklist missed", () => {
  it("refuses Azure's WireServer address", async () => {
    expect(await hostIsPublic("168.63.129.16")).toBe(false);
    // Its neighbours in 168.63/16 are not otherwise special, and public space
    // must keep working.
    expect(await hostIsPublic("8.8.8.8")).toBe(true);
  });

  it("refuses the IPv4-translated IPv6 form of a metadata address", async () => {
    // WHATWG normalises [::ffff:0:169.254.169.254] to this spelling.
    expect(await hostIsPublic("::ffff:0:a9fe:a9fe")).toBe(false);
    expect(await hostIsPublic("[::ffff:0:a9fe:a9fe]")).toBe(false);
    expect(await hostIsPublic("::ffff:0:a83f:8110")).toBe(false); // 168.63.129.16
    // The mapped form is still refused, public space is not.
    expect(await hostIsPublic("::ffff:a9fe:a9fe")).toBe(false);
    expect(await hostIsPublic("2606:4700:4700::1111")).toBe(true);
  });
});

describe("pass 62 — invisible characters cannot split a blocked word", () => {
  it.each([
    ["nud\u0001e woman", "C0 control"],
    ["nud\u0007e woman", "BEL"],
    ["nud\u0085e woman", "C1 NEL"],
    ["nud\u2800e woman", "braille blank"],
    ["nud\u{1F3FB}e woman", "emoji skin-tone modifier"],
  ])("blocks %j (%s)", (prompt) => {
    expect(checkPrompt(prompt).ok).toBe(false);
  });

  it("still sees separators as separators", () => {
    // Stripping controls must not join words ACROSS whitespace: these match
    // only because the separated view keeps the space/newline.
    expect(checkPrompt("bomb\nmaking").ok).toBe(false);
    expect(checkPrompt("child\nporn").ok).toBe(false);
    expect(checkPrompt("bomb\tmaking").ok).toBe(false);
  });

  it("does not block ordinary prose or an invisible character alone", () => {
    for (const prompt of ["Essex", "sextant", "nudibranch", "underagents", "a calm lake", "\u2800"]) {
      expect(checkPrompt(prompt).ok, prompt).toBe(true);
    }
  });
});

describe("pass 62 — mock image output requires an actual test deployment", () => {
  it("refuses PAYMENT_ALLOW_MOCK with a real provider", () => {
    expect(() =>
      mockImageProviderEnabled({
        NODE_ENV: "production",
        MOCK_IMAGE_PROVIDER: "1",
        PAYMENT_ALLOW_MOCK: "1",
        PAYMENT_PROVIDER: "stripe",
      } as NodeJS.ProcessEnv),
    ).toThrow(/mock-image-provider-not-allowed/);
  });

  it("allows it only with the mock provider (or none) in production", () => {
    expect(
      mockImageProviderEnabled({
        NODE_ENV: "production",
        MOCK_IMAGE_PROVIDER: "1",
        PAYMENT_ALLOW_MOCK: "1",
        PAYMENT_PROVIDER: "mock",
      } as NodeJS.ProcessEnv),
    ).toBe(true);
    expect(
      mockImageProviderEnabled({
        NODE_ENV: "production",
        MOCK_IMAGE_PROVIDER: "1",
        PAYMENT_ALLOW_MOCK: "1",
      } as NodeJS.ProcessEnv),
    ).toBe(true);
  });

  it("is refused at boot when the flag is set beside a real provider", () => {
    expect(() =>
      assertProductionConfig({
        NODE_ENV: "production",
        NEXTAUTH_SECRET: SECRET,
        NEXTAUTH_URL: "https://pixelduo.example.com",
        SMTP_URL: "smtp://user:pass@smtp.example.com:587",
        PAYMENT_PROVIDER: "stripe",
        PAYMENT_ALLOW_MOCK: "1",
        MOCK_IMAGE_PROVIDER: "1",
      } as NodeJS.ProcessEnv),
    ).toThrow(/MOCK_IMAGE_PROVIDER/);
  });
});

describe("pass 62 — a mock deployment cannot mint plantable cookies on a public origin", () => {
  const base = {
    NODE_ENV: "production",
    NEXTAUTH_SECRET: SECRET,
    PAYMENT_PROVIDER: "mock",
    PAYMENT_ALLOW_MOCK: "1",
  };

  it("accepts https anywhere and http only on a local/private host", () => {
    expect(() =>
      assertProductionConfig({ ...base, NEXTAUTH_URL: "https://pixelduo.example.com" } as NodeJS.ProcessEnv),
    ).not.toThrow();
    expect(() =>
      assertProductionConfig({ ...base, NEXTAUTH_URL: "http://localhost:3100" } as NodeJS.ProcessEnv),
    ).not.toThrow();
    expect(() =>
      assertProductionConfig({ ...base, NEXTAUTH_URL: "http://192.168.1.20:3000" } as NodeJS.ProcessEnv),
    ).not.toThrow();
    expect(() =>
      assertProductionConfig({ ...base, NEXTAUTH_URL: "http://pixelduo.example.com" } as NodeJS.ProcessEnv),
    ).toThrow(/NEXTAUTH_URL/);
  });

  it("recognises the local/private spellings and nothing else", () => {
    for (const h of ["localhost", "127.0.0.1", "10.2.3.4", "172.16.9.9", "192.168.0.7", "::1", "fd12::1", "fe80::1", "nas.local"]) {
      expect(isLocalOrPrivateHostname(h), h).toBe(true);
    }
    for (const h of ["pixelduo.ai", "8.8.8.8", "172.32.0.1", "evil.local.example.com"]) {
      expect(isLocalOrPrivateHostname(h), h).toBe(false);
    }
  });
});

describe("pass 62 — the reminder claim is serialized with erasure", () => {
  it("writes no reminder for an account erased inside the claim window", async () => {
    const user = await makeUser();
    const grant = await prisma.creditGrant.create({
      data: {
        userId: user.id,
        source: "PURCHASE",
        amount: 10,
        remaining: 10,
        expiresAt: new Date(Date.now() + 20 * 60 * 60 * 1000), // 1 day bucket
      },
    });
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const erasure = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${user.id} FOR UPDATE`;
        // The erasure's own sweep of reminders runs before the User row goes;
        // a claim committing after this point is exactly the residue.
        await tx.creditReminder.deleteMany({ where: { userId: user.id } });
        release();
        await new Promise((r) => setTimeout(r, 800));
        await tx.user.delete({ where: { id: user.id } });
      },
      { timeout: 20_000 },
    );
    await ready;
    const reminders = sendExpiryReminders({ userId: user.id });
    await erasure;
    await reminders;
    expect(await prisma.creditReminder.count({ where: { grantId: grant.id } })).toBe(0);
    // The row has no FK, so a regressed implementation would leave it behind
    // even after the User cascade — clean it up for the next file.
    await prisma.creditReminder.deleteMany({ where: { userId: user.id } });
  }, 30_000);
});

describe("pass 62 — an admin write is re-authorized at commit", () => {
  it("refuses once the actor is demoted or their session is revoked", async () => {
    const admin = await makeUser({ role: "admin" });
    await expect(assertAdminActorTx(prisma, { id: admin.id, sv: 0 })).resolves.toBeUndefined();
    // Revocation: the session version moved.
    await prisma.user.update({ where: { id: admin.id }, data: { sessionVersion: { increment: 1 } } });
    await expect(assertAdminActorTx(prisma, { id: admin.id, sv: 0 })).rejects.toMatchObject({
      status: 401,
    });
    // Demotion.
    await prisma.user.update({ where: { id: admin.id }, data: { role: "user" } });
    await expect(assertAdminActorTx(prisma, { id: admin.id, sv: 1 })).rejects.toMatchObject({
      status: 403,
    });
  });

  it("refuses an actor whose row was erased", async () => {
    const gone = await makeUser({ role: "admin" });
    const id = gone.id;
    await prisma.user.delete({ where: { id } });
    await expect(assertAdminActorTx(prisma, { id, sv: 0 })).rejects.toMatchObject({ status: 403 });
  });
});

describe("pass 62 — cycle spend is attributed in SQL, not by loading every job", () => {
  it("counts only jobs whose consumption names the funding grant", async () => {
    const user = await makeUser();
    const grant = await prisma.creditGrant.create({
      data: {
        userId: user.id,
        source: "SUBSCRIPTION",
        amount: 100,
        remaining: 80,
        expiresAt: new Date(Date.now() - 60_000), // already ended
      },
    });
    const mine = await prisma.job.create({
      data: {
        userId: user.id,
        model: "gpt",
        quality: "medium",
        count: 1,
        prompt: "p62 mine",
        costCredits: 8,
        images: "[]",
        consumption: [{ grantId: grant.id, amount: 8 }] as object,
      },
    });
    const other = await prisma.job.create({
      data: {
        userId: user.id,
        model: "gpt",
        quality: "medium",
        count: 1,
        prompt: "p62 other",
        costCredits: 4,
        images: "[]",
        // Same prefix, longer id — containment must not be a substring match.
        consumption: [{ grantId: `${grant.id}x`, amount: 4 }] as object,
      },
    });
    const legacy = await prisma.job.create({
      data: {
        userId: user.id,
        model: "gpt",
        quality: "medium",
        count: 1,
        prompt: "p62 legacy",
        costCredits: 5,
        images: "[]",
      },
    });
    await prisma.ledgerEntry.createMany({
      data: [
        { userId: user.id, type: "PRE_AUTH", creditsDelta: -8, balanceAfter: 92, refType: "job", refId: mine.id },
        { userId: user.id, type: "PRE_AUTH", creditsDelta: -4, balanceAfter: 88, refType: "job", refId: other.id },
        { userId: user.id, type: "PRE_AUTH", creditsDelta: -5, balanceAfter: 83, refType: "job", refId: legacy.id },
      ],
    });
    // The JS predicate and the SQL containment must agree about all three.
    expect(consumesGrant([{ grantId: grant.id, amount: 8 }], grant.id)).toBe(true);
    const usage = await cycleUsage(user.id, grant.expiresAt!);
    expect(usage.granted).toBe(100);
    expect(usage.spentNet).toBe(8);
  });
});

describe("pass 62 — a client-chosen XFF cannot address another feature's bucket", () => {
  it("namespaces IP buckets under the route's own scope", async () => {
    const saved = process.env.REDIS_URL;
    delete process.env.REDIS_URL;
    _resetLimiterForTests();
    try {
      const req = new Request("http://local/api/feedback", {
        method: "POST",
        headers: { "x-forwarded-for": "notify-global" },
      });
      for (let i = 0; i < 5; i++) {
        expect(await enforceRateLimit(req, "feedback", 5, 60_000)).toBeNull();
      }
      // The sixth is refused — that is the IP bucket being spent.
      expect(await enforceRateLimit(req, "feedback", 5, 60_000)).not.toBeNull();
      // The shared notification ceiling (its own Redis key) is untouched.
      const feature = await rateLimit("feedback:notify-global", 5, 60_000);
      expect(feature.ok).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.REDIS_URL;
      else process.env.REDIS_URL = saved;
      _resetLimiterForTests();
    }
  });
});

describe("pass 62 — deep bodies and absolute storage keys are refused", () => {
  it("refuses a body nested past the walk's bound instead of skipping it", () => {
    let deep: unknown = { value: "ok" };
    for (let i = 0; i < 40; i++) deep = { nested: deep };
    expect(() => parseJsonBody(JSON.stringify(deep))).toThrow(/nested too deeply/);
    // A realistic depth still parses.
    let shallow: unknown = { value: "ok" };
    for (let i = 0; i < 20; i++) shallow = { nested: shallow };
    expect(parseJsonBody(JSON.stringify(shallow))).toBeTruthy();
  });

  it("404s a percent-encoded leading slash instead of reading a storage key", async () => {
    const req = new Request("http://local/api/files/%2Ftemplates/x.png");
    const res = await filesGet(req, { params: Promise.resolve({ key: ["/templates/x.png"] }) });
    expect(res.status).toBe(404);
  });
});

describe("pass 62 — ops fixes are present in the shipped files", () => {
  const read = (f: string) => readFileSync(path.join(REPO, f), "utf8");

  it("creates the MinIO bucket idempotently so the backup loop still starts", () => {
    expect(read("docker-compose.yml")).toContain("mc mb --ignore-existing -p local/");
  });

  it("drops Caddy's default capabilities in both production composes", () => {
    for (const f of ["docker-compose.prod.yml", "docker-compose.single.yml"]) {
      const yml = read(f);
      const caddy = yml.slice(yml.indexOf("\n  caddy:"));
      expect(caddy.slice(0, 800), f).toContain("cap_drop:");
      expect(caddy.slice(0, 800), f).toContain("NET_BIND_SERVICE");
    }
  });

  it("writes the fixed-path script outputs without following symlinks", () => {
    expect(read("scripts/dev-smtp-sink.mjs")).toContain("O_NOFOLLOW");
    expect(read("scripts/smoke-live.ts")).toContain("O_NOFOLLOW");
  });

  it("seeds templates by upsert, deleting only on --reset", () => {
    const seed = read("prisma/seed.ts");
    expect(seed).toContain('process.argv.includes("--reset")');
    expect(seed).toContain("template.upsert");
  });
});
