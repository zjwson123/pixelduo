import { afterAll, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// Pass 23. Four classes of finding, each with the case that reproduces it:
//
//   - two advisories that appeared WITHOUT a commit, in code already shipped:
//     next 16.3.4 carries GHSA-vcvr-r3jv-pc5j (RCE in the Node.js `next/og`
//     ImageResponse renderer, fixed in 16.3.6 — this app never imports next/og,
//     so it is not reachable here, but the dependency is the runtime tree and
//     the bump is a patch) and brace-expansion 5.0.9 carries GHSA-q2hr-2g5m-vwhr
//     (quadratic-time expansion, fixed in 5.0.12). The production tree now
//     audits clean, and CI gates that (`npm audit --omit=dev --audit-level=high`)
//     so the next one does not need a human to notice it. Every previous
//     advisory — nodemailer 10.0.1, next 16.3.4 — was found by hand.
//   - the storage health probe wrote and unlinked ONE fixed `.health` file, so
//     two overlapping probes raced: the loser's unlink threw ENOENT, the catch
//     turned it into `false`, and /api/health answered 503 storage:"down".
//     Every consumer reads only the status, so a concurrent probe could forge
//     an outage and pull a healthy instance out of rotation.
//   - the health route cached a probe only when it FINISHED, so a burst arriving
//     before that ran one full probe per request (DB + Redis + Job query + a
//     storage write) from an endpoint that needs no credential.
//   - a paid webhook event that resolved no order was persisted and acked in
//     silence: money captured, nothing granted, no operator signal, and every
//     provider retry deduped by eventId so nothing ever looked at it again.
//
// Every case below was confirmed to FAIL against the pre-fix source.
const REPO = process.cwd();
const readJson = (p: string) => JSON.parse(fs.readFileSync(path.join(REPO, p), "utf8"));

/** Numeric compare of `major.minor.patch`, ignoring prerelease/build metadata. */
function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split("-")[0].split(".").map((n) => Number(n) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  }
  return 0;
}

/** The lowest version a caret/tilde/exact range can resolve to. */
function rangeFloor(range: string): string {
  const m = /^\s*[\^~]?\s*(\d+\.\d+\.\d+)/.exec(range);
  if (!m) throw new Error(`cannot read a version floor out of "${range}"`);
  return m[1];
}

// Nothing in this file needs a session; the mocks exist so the two route
// handlers can be imported without booting Next.
const getServerSession = vi.fn();
vi.mock("next-auth", () => ({
  getServerSession: (...args: unknown[]) => getServerSession(...args),
}));

// The health route's storage probe is counted rather than mocked: the driver is
// a singleton created on first use, so a fresh root plus a wrapped method is
// enough to observe how many probes a burst actually runs.
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pd-storage-"));
process.env.LOCAL_STORAGE_DIR = storageRoot;

// captureError is the operator signal under test.
const captured: Array<{ message: string; ctx?: Record<string, unknown> }> = [];
vi.mock("../lib/observability", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/observability")>();
  return {
    ...actual,
    captureError: (e: unknown, ctx?: Record<string, unknown>) => {
      captured.push({ message: e instanceof Error ? e.message : String(e), ctx });
    },
  };
});

// An in-process limiter keeps this file's buckets out of Redis.
delete process.env.REDIS_URL;
process.env.PAYMENT_PROVIDER = "mock";

const { prisma } = await import("../lib/prisma");
const { getStorage } = await import("../lib/storage");
const { GET: healthGET } = await import("../app/api/health/route");
const { POST: webhookPOST } = await import("../app/api/webhooks/payment/route");
const { POST: feedbackPOST } = await import("../app/api/feedback/route");

const storage = getStorage();
/** The driver's real probe, unpatched, bound to this file's scratch root. */
const realHealth = storage.health.bind(storage);
let healthCalls = 0;
storage.health = async () => {
  healthCalls += 1;
  // Real latency, so N concurrent requests genuinely overlap.
  await new Promise((resolve) => setTimeout(resolve, 40));
  return realHealth();
};

const stamp = Date.now();

afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(storageRoot, { recursive: true, force: true });
});

describe("pass 23 — the runtime dependency tree carries no open advisory", () => {
  it("pins next at or above the next/og RCE fix (16.3.6)", () => {
    const lock = readJson("package-lock.json");
    expect(compareVersions(lock.packages["node_modules/next"].version, "16.3.6")).toBeGreaterThanOrEqual(0);
    // The declared range is what a fresh resolution may land on; `^16.3.4`
    // admits the vulnerable 16.3.4 and 16.3.5.
    expect(compareVersions(rangeFloor(readJson("package.json").dependencies.next), "16.3.6")).toBeGreaterThanOrEqual(0);
  });

  it("pins brace-expansion at or above the quadratic-expansion fix (5.0.12)", () => {
    const lock = readJson("package-lock.json");
    const copies = Object.entries(lock.packages)
      .filter(([k]) => k.endsWith("node_modules/brace-expansion"))
      .map(([, v]) => (v as { version: string }).version);
    expect(copies.length).toBeGreaterThan(0);
    for (const version of copies) {
      expect(compareVersions(version, "5.0.12")).toBeGreaterThanOrEqual(0);
    }
  });

  it("gates the runtime tree in CI and in the local replica", () => {
    // The gate is the point: an advisory appears without a commit, and both of
    // the ones found so far were found by a human running `npm audit` by hand.
    const ci = fs.readFileSync(path.join(REPO, ".github", "workflows", "ci.yml"), "utf8");
    expect(ci).toMatch(/npm audit --omit=dev --audit-level=high/);
    const local = fs.readFileSync(path.join(REPO, "scripts", "ci-local.sh"), "utf8");
    expect(local).toMatch(/npm audit --omit=dev --audit-level=high/);
  });
});

describe("pass 23 — a storage probe cannot be raced into a false 'down'", () => {
  it("answers true for every concurrent probe of one root", async () => {
    // Pre-fix every probe wrote and unlinked the same `<root>/.health`, so
    // whoever unlinked second got ENOENT and reported the whole driver
    // unhealthy — and /api/health turns that into a 503.
    const results = await Promise.all(Array.from({ length: 8 }, () => realHealth()));
    expect(results).toEqual(Array(8).fill(true));
    // And the probe leaves nothing behind either way.
    expect(fs.readdirSync(storageRoot)).toEqual([]);
  });
});

describe("pass 23 — /api/health runs one probe per burst, not one per request", () => {
  it("shares a single probe between concurrent unauthenticated requests", async () => {
    healthCalls = 0;
    const req = () =>
      new Request("http://localhost:3100/api/health", {
        headers: { "x-forwarded-for": "10.0.0.9, 203.0.113.99" },
      });
    const responses = await Promise.all(Array.from({ length: 8 }, () => healthGET(req())));
    for (const res of responses) expect([200, 503]).toContain(res.status);
    // Pre-fix: 8 probes (the cache is only written when a probe finishes, so
    // every request in the burst missed it and paid for a full probe).
    expect(healthCalls).toBe(1);
  });
});

describe("pass 23 — a report cannot forge lines in the operator's notification", () => {
  it("refuses a feedback page carrying control characters", async () => {
    // The value lands in the mail's machine-generated context block
    // (lib/mail.ts prints `page: <value>` next to `from:`/`plan:`) and in the
    // webhook line (lib/notify.ts). A newline forged extra lines, so an
    // anonymous report could be made to read as a verified account's.
    const forged =
      "/studio\nfrom:     ceo@corp.example (user victim-id)\nplan:     enterprise";
    const res = await feedbackPOST(
      new Request("http://localhost:3100/api/feedback", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "10.0.0.9, 203.0.113.101" },
        body: JSON.stringify({
          category: "bug",
          message: "the export button does nothing on Firefox",
          page: forged,
          locale: "en",
        }),
      }),
    );
    expect(res.status).toBe(400);
    // A normal pathname-shaped value still goes through the schema.
    const okRes = await feedbackPOST(
      new Request("http://localhost:3100/api/feedback", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "10.0.0.9, 203.0.113.102" },
        body: JSON.stringify({
          category: "bug",
          message: "the gallery tab loses my scroll position after a refresh",
          page: "/studio?tab=gallery",
          locale: "en",
        }),
      }),
    );
    expect(okRes.status).toBe(200);
    await prisma.feedback.deleteMany({ where: { page: "/studio?tab=gallery" } });
  });
});

describe("pass 23 — a paid event that resolves no order is reported", () => {
  it("captures the orphan payment instead of acking it silently", async () => {
    captured.length = 0;
    const res = await webhookPOST(
      new Request("http://localhost/api/webhooks/payment", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          eventId: `evt-paid-orphan-${stamp}`,
          status: "paid",
          orderId: "order-that-does-not-exist",
        }),
      }),
    );
    // The delivery is still acked (a 500 would make the provider retry a
    // condition no retry can resolve), but it must leave a signal.
    expect(res.status).toBe(200);
    expect(captured.map((c) => c.message).join("\n")).toMatch(/resolved no order/);
  });
});
