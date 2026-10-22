import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import bcrypt from "bcryptjs";

// Pass 44.
//
//   - /api/account/export returned the whole LedgerEntry row (`actorId`, the
//     acting admin's User.id) and the whole Feedback row (`handledBy`, the
//     closing operator's id). Pass 43 removed exactly those two identifiers
//     from /api/ledger; the export was the second view of the same rows.
//   - ApiKey has no FK to User, so a key mint could commit between the erasure
//     transaction's apiKey.deleteMany and its user.delete, leaving key metadata
//     behind for an account the erasure reported as gone.
//   - 2fa/setup wrote totpPendingSecret with no sessionVersion predicate: a
//     reset/revoke landing during the password compare still committed the
//     attacker's pending secret (inert, but account state written by a retired
//     credential).
//   - The admin moderation preview buffered the whole object (up to 100 MB of
//     video) into the web process — 120/min of that is an OOM of the container
//     serving every user.
//   - The video-concat budget allowed ~576 MB of heap in a 512 MB container,
//     and a terminal failJob's sweep observation did not include the checkpoint
//     it was about to reclaim.

const getServerSession = vi.fn();
vi.mock("next-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-auth")>();
  return { ...actual, getServerSession: (...args: unknown[]) => getServerSession(...args) };
});

// A revocation landing after 2fa/setup's guard read but during its password
// compare. bcrypt is the route's last await before the write, so hooking it is
// the deterministic way to place the revoke inside that window.
const BCRYPT_HOOK = vi.hoisted(() => ({ fn: null as null | (() => Promise<void>) }));
vi.mock("bcryptjs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("bcryptjs")>();
  const real = (actual as unknown as { default?: typeof import("bcryptjs") }).default ?? actual;
  return {
    ...(actual as object),
    default: {
      ...real,
      compare: async (a: string, b: string) => {
        if (BCRYPT_HOOK.fn) {
          const fn = BCRYPT_HOOK.fn;
          BCRYPT_HOOK.fn = null;
          await fn();
        }
        return real.compare(a, b);
      },
    },
  };
});

const STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "p44-storage-"));
process.env.STORAGE_DRIVER = "local";
process.env.LOCAL_STORAGE_DIR = STORAGE_DIR;

const { prisma } = await import("../lib/prisma");
const { POST: exportPost } = await import("../app/api/account/export/route");
const { POST: keysPost } = await import("../app/api/account/keys/route");
const { POST: setupPost } = await import("../app/api/2fa/setup/route");
const { GET: adminImageGet } = await import("../app/api/admin/images/[id]/route");
const { getStorage, _resetStorageForTests } = await import("../lib/storage");
const { failJob } = await import("../lib/queue");
const { concatInputsWithinBudget, CONCAT_MAX_INPUT_BYTES, CONCAT_MAX_IN_HEAP_BYTES } =
  await import("../lib/video-concat");

let seq = 0;
const tag = `pass44-${Date.now()}`;

async function makeUser(extra: Record<string, unknown> = {}) {
  return prisma.user.create({
    data: { email: `${tag}-${seq++}@test.dev`, passwordHash: "x", name: "Pass 44", ...extra },
  });
}

function session(user: { id: string }, sv = 0) {
  getServerSession.mockResolvedValue({
    user: { id: user.id, sv, totpPending: false },
  });
}

function jsonReq(url: string, body: unknown) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeAll(() => {
  _resetStorageForTests();
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { startsWith: tag } } });
  await prisma.$disconnect();
  fs.rmSync(STORAGE_DIR, { recursive: true, force: true });
});

describe("pass 44 — the data export does not carry the operator's id", () => {
  it("omits actorId/handledBy and nulls an admin refId", async () => {
    const admin = await makeUser({ role: "admin", emailVerified: new Date() });
    const user = await makeUser({ emailVerified: new Date() });
    await prisma.ledgerEntry.create({
      data: {
        userId: user.id,
        type: "ADMIN",
        creditsDelta: -5,
        balanceAfter: 0,
        refType: "admin",
        refId: admin.id,
        actorId: admin.id,
        note: "clawback",
      },
    });
    await prisma.feedback.create({
      data: {
        userId: user.id,
        email: user.email,
        category: "bug",
        message: "a report",
        status: "done",
        handledBy: admin.id,
        handledAt: new Date(),
      },
    });
    session(user);
    const res = await exportPost();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        ledger: Array<Record<string, unknown>>;
        feedback: Array<Record<string, unknown>>;
      };
    };
    expect(body.data.ledger).toHaveLength(1);
    expect(body.data.ledger[0]).not.toHaveProperty("actorId");
    expect(body.data.ledger[0].refId).toBeNull();
    expect(body.data.feedback).toHaveLength(1);
    expect(body.data.feedback[0]).not.toHaveProperty("handledBy");
    // The handling time is the user's own data and stays.
    expect(body.data.feedback[0].handledAt).not.toBeNull();
  });
});

describe("pass 44 — a key mint cannot outlive an erasure", () => {
  it("blocks on the User row and refuses once the erasure commits", async () => {
    const user = await makeUser({
      emailVerified: new Date(),
      passwordHash: await bcrypt.hash("password123", 10),
    });
    session(user);

    // Mimic the erasure transaction's decisive window: User locked, keys
    // deleted, a pause (the storage sweep's duration), then the user deleted.
    // A mint that is not serialized here inserts between the two statements and
    // survives the erasure; ApiKey has no FK to stop it.
    let locked!: () => void;
    const atLock = new Promise<void>((resolve) => (locked = resolve));
    const erasure = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${user.id} FOR UPDATE`;
        await tx.apiKey.deleteMany({ where: { userId: user.id } });
        locked();
        await new Promise((resolve) => setTimeout(resolve, 600));
        await tx.user.delete({ where: { id: user.id } });
      },
      { timeout: 15_000 },
    );
    await atLock;

    const res = await keysPost(
      jsonReq("http://localhost/api/account/keys", { password: "password123", name: "p44" }),
    );
    await erasure;

    expect(res.status).toBe(401);
    expect(await prisma.apiKey.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.user.count({ where: { id: user.id } })).toBe(0);
  }, 20_000);
});

describe("pass 44 — 2fa/setup is fenced on the session version", () => {
  it("does not write a pending secret under a credential revoked mid-request", async () => {
    const user = await makeUser({
      emailVerified: new Date(),
      passwordHash: await bcrypt.hash("password123", 10),
    });
    session(user);

    // A revoke-sessions/reset landing after the guard's read: bump the version
    // during the password compare, i.e. immediately before the guarded write.
    // The CAS must then match nothing.
    BCRYPT_HOOK.fn = async () => {
      await prisma.user.update({
        where: { id: user.id },
        data: { sessionVersion: { increment: 1 } },
      });
    };

    const res = await setupPost(jsonReq("http://localhost/api/2fa/setup", { password: "password123" }));
    BCRYPT_HOOK.fn = null;

    expect(res.status).toBe(401);
    const after = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { totpPendingSecret: true, sessionVersion: true },
    });
    expect(after.sessionVersion).toBe(1);
    expect(after.totpPendingSecret).toBeNull();
  });
});

describe("pass 44 — the admin preview streams instead of buffering", () => {
  it("serves the bytes through getStream", async () => {
    const admin = await makeUser({ role: "admin", emailVerified: new Date() });
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    const key = `img/${tag}-preview.png`;
    await getStorage().put(key, bytes, "image/png");
    const image = await prisma.image.create({
      data: { userId: admin.id, url: key, model: "gpt", quality: "medium", prompt: "x", credits: 0 },
    });
    session(admin);

    const storage = getStorage();
    const getSpy = vi.spyOn(storage, "get").mockImplementation(() => {
      throw new Error("the preview must not buffer the object");
    });
    const res = await adminImageGet(new Request("http://localhost/api/admin/images/x"), {
      params: Promise.resolve({ id: image.id }),
    });
    getSpy.mockRestore();

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(bytes);
  });
});

describe("pass 44 — a stale recovery observation cannot miss a new checkpoint", () => {
  it("stands down when Job.images moved after the sweep's read", async () => {
    const user = await makeUser();
    const t0 = new Date(Date.now() - 20 * 60_000);
    const job = await prisma.job.create({
      data: {
        userId: user.id,
        model: "gpt",
        mediaType: "image",
        quality: "medium",
        count: 1,
        prompt: "p44 checkpoint",
        costCredits: 0,
        images: "[]",
        status: "polling",
        worker: "p44-peer",
        startedAt: t0,
        heartbeatAt: t0,
        attempts: 1,
        maxAttempts: 3,
      },
    });
    // The holder checkpointed between the sweep's SELECT and its CAS.
    await prisma.job.update({
      where: { id: job.id },
      data: { images: JSON.stringify([{ key: "img/p44-new.png", model: "gpt" }]) },
    });

    const transitioned = await failJob(job.id, "stuck-timeout: worker heartbeat expired", {
      expect: { status: "polling", heartbeatAt: t0, startedAt: t0, images: "[]" },
    });

    expect(transitioned).toBe(false);
    const after = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.status).toBe("polling");
    expect(after.attempts).toBe(1);
    expect(after.images).toContain("p44-new.png");
  });
});

describe("pass 44 — the concat budget bounds the process peak", () => {
  it("keeps inputs + in-heap output under the worker container", () => {
    // The old pair (320 MB inputs + a 256 MB output read) was ~576 MB in a
    // 512 MB container. The output read is now separately capped.
    expect(CONCAT_MAX_INPUT_BYTES + CONCAT_MAX_IN_HEAP_BYTES).toBeLessThanOrEqual(320 * 1024 * 1024);
    expect(concatInputsWithinBudget(200 * 1024 * 1024, 56 * 1024 * 1024)).toBe(true);
    expect(concatInputsWithinBudget(CONCAT_MAX_INPUT_BYTES, 1)).toBe(false);
  });
});
