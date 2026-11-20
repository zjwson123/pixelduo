import { afterAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Pass 65.
//
//   - `prisma/seed.ts` copied `designs/pixelduo/assets/*` into the
//     unauthenticated public/ tree with `readdirSync` + `copyFileSync`, which
//     follows symlinks at BOTH ends. A data-only commit turning a tracked PNG
//     into a symlink to `.env` would publish the deployment's secrets at
//     /templates/<name> on the next documented `npm run db:seed`; a symlink at
//     the destination made the copy overwrite whatever it pointed at.
//   - `scripts/import-cases.ts` stored whatever bytes the third-party upstream
//     served as a Template image. Paths, symlinks and sourceUrl were guarded;
//     the bytes were not. An SVG/HTML payload became content hosted under the
//     app's origin, and a decompression bomb was cached client-side for a year.
//   - /api/files took a concurrency slot only for BODY streams. HEAD and the
//     Range size lookup were unbounded metadata calls on the same S3 agent, so
//     one account could pin the socket pool the body cap exists to protect.
//   - completeJob stamped `finishedAt` from the app clock, the last
//     money-adjacent terminal timestamp not on the database clock.
//   - A won Stripe dispute always leaves the order `refunded` (un-revoking is
//     deliberately manual), but unlike Paddle's reversal it raised no operator
//     signal at all.

const REPO = path.resolve(__dirname, "..");
const TEMP_ROOTS: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "p65-assets-"));
  TEMP_ROOTS.push(root);
  return root;
}

function assetRoot(): string {
  const root = tempRoot();
  fs.mkdirSync(path.join(root, "designs", "pixelduo", "assets"), { recursive: true });
  fs.mkdirSync(path.join(root, "public"), { recursive: true });
  return root;
}

const { copyTemplateAssets } = await import("../scripts/copy-template-assets");
const { isSafeCaseImage } = await import("../scripts/import-case-image");

// 1x1 PNG — real magic bytes and a decodable header.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

afterAll(() => {
  for (const root of TEMP_ROOTS) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

describe("pass 65 — seed template assets refuse symlinks at both ends", () => {
  it("copies ordinary files", () => {
    const root = assetRoot();
    fs.writeFileSync(path.join(root, "designs", "pixelduo", "assets", "a.png"), "IMAGE");
    expect(copyTemplateAssets(root)).toEqual(["a.png"]);
    expect(fs.readFileSync(path.join(root, "public", "templates", "a.png"), "utf8")).toBe("IMAGE");
  });

  it("refuses a symlinked source instead of publishing its target", () => {
    const root = assetRoot();
    const secret = path.join(root, "secret.txt");
    fs.writeFileSync(secret, "NEXTAUTH_SECRET=do-not-publish");
    fs.symlinkSync(secret, path.join(root, "designs", "pixelduo", "assets", "leak.png"));
    expect(() => copyTemplateAssets(root)).toThrow(/not a regular file/);
    expect(fs.existsSync(path.join(root, "public", "templates", "leak.png"))).toBe(false);
  });

  it("replaces a symlinked destination without writing through it", () => {
    const root = assetRoot();
    const outside = path.join(root, "outside.txt");
    fs.writeFileSync(outside, "KEEP");
    const dst = path.join(root, "public", "templates");
    fs.mkdirSync(dst, { recursive: true });
    fs.symlinkSync(outside, path.join(dst, "target.png"));
    fs.writeFileSync(path.join(root, "designs", "pixelduo", "assets", "target.png"), "IMAGE");
    copyTemplateAssets(root);
    expect(fs.lstatSync(path.join(dst, "target.png")).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(dst, "target.png"), "utf8")).toBe("IMAGE");
    expect(fs.readFileSync(outside, "utf8")).toBe("KEEP");
  });

  it("refuses a symlinked source directory", () => {
    const root = tempRoot();
    const elsewhere = path.join(root, "elsewhere");
    fs.mkdirSync(path.join(elsewhere, "pixelduo", "assets"), { recursive: true });
    fs.writeFileSync(path.join(elsewhere, "pixelduo", "assets", "a.png"), "IMAGE");
    fs.mkdirSync(path.join(root, "public"), { recursive: true });
    fs.symlinkSync(elsewhere, path.join(root, "designs"));
    // lstat sees the resolved target (a real directory); the realpath check is
    // what catches the intermediate symlink.
    expect(() => copyTemplateAssets(root)).toThrow(/not a real directory|resolves outside/);
  });
});

describe("pass 65 — imported template bytes must be a bounded raster", () => {
  it("accepts a real PNG", async () => {
    await expect(isSafeCaseImage(TINY_PNG)).resolves.toBe(true);
  });

  it("refuses SVG and arbitrary bytes", async () => {
    await expect(isSafeCaseImage(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).resolves.toBe(
      false,
    );
    await expect(isSafeCaseImage(Buffer.from("not an image at all"))).resolves.toBe(false);
  });

  it("refuses a raster magic header with a corrupt body", async () => {
    const truncated = Buffer.concat([TINY_PNG.subarray(0, 8), Buffer.from("garbage")]);
    await expect(isSafeCaseImage(truncated)).resolves.toBe(false);
  });
});

describe("pass 65 — one database clock for delivery timestamps", () => {
  it("completeJob stamps finishedAt with dbNow, not new Date()", () => {
    const queue = fs.readFileSync(path.join(REPO, "lib", "queue.ts"), "utf8");
    expect(queue).toMatch(/const finishedAt = await dbNow\(tx\);/);
    expect(queue).toMatch(/error: null, finishedAt \}/);
    expect(queue).not.toMatch(/finishedAt: new Date\(\)/);
  });
});

// ---------------------------------------------------------------------------
// Behavioural test for the operator alert. The route is driven for real; only
// next-auth (imported transitively by lib/api) is stubbed, and the mock payment
// provider accepts an unsigned body, exactly like tests/pass43-hardening.
const getServerSession = vi.fn();
vi.mock("next-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-auth")>();
  return { ...actual, getServerSession: (...args: unknown[]) => getServerSession(...args) };
});
process.env.STORAGE_DRIVER = "local";
process.env.LOCAL_STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "p65-storage-"));

const { prisma } = await import("../lib/prisma");
const { POST: webhookPOST } = await import("../app/api/webhooks/payment/route");
const { grantCreditsTx } = await import("../lib/ledger");

let seq = 0;
const tag = `pass65-${Date.now()}`;

describe("pass 65 — a won dispute on a revoked order alerts the operator", () => {
  it("keeps the manual-remedy policy but reports the state that needs one", async () => {
    const user = await prisma.user.create({
      data: { email: `${tag}-${seq++}@test.dev`, passwordHash: "x", name: "Pass 65" },
    });
    const order = await prisma.order.create({
      data: {
        userId: user.id,
        kind: "pack",
        status: "paid",
        amountUsd: 49.99,
        credits: 6000,
        provider: "mock",
        idempotencyKey: `${tag}-order-${seq++}`,
      },
    });
    await prisma.$transaction((tx) =>
      grantCreditsTx(tx, user.id, "PURCHASE", 6000, null, "order", order.id),
    );
    const send = (body: Record<string, unknown>) =>
      webhookPOST(
        new Request("http://localhost/api/webhooks/payment", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "refunded", orderId: order.id, ...body }),
        }),
      );

    // A full chargeback revokes the credits and the order.
    expect(
      (await send({ eventId: `${tag}-d`, disputedAmountUsd: 49.99, disputeId: "dp_p65" })).status,
    ).toBe(200);
    let row = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.status).toBe("refunded");

    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // Won: the disputed total comes down, but nothing is un-revoked
      // automatically — the operator must be told a re-grant is the remedy.
      expect(
        (await send({
          eventId: `${tag}-won`,
          reinstatedAmountUsd: 49.99,
          reinstatedDisputeId: "dp_p65",
        })).status,
      ).toBe(200);
      row = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(row.status).toBe("refunded");
      expect(row.disputedAmountUsd).toBe(0);
      expect(errors.mock.calls.some((c) => String(c[0]).includes("dispute-reinstated"))).toBe(true);
    } finally {
      errors.mockRestore();
    }
  });
});
