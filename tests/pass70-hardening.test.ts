import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// The API-key mint test drives the real handler; next-auth's session helper is
// stubbed the way tests/pass16-hardening.test.ts does (the real one reaches for
// next/headers' cookies() and has no request store under vitest).
const getServerSession = vi.fn();
vi.mock("next-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-auth")>();
  return {
    ...actual,
    default: () => async () => new Response("{}", { status: 200 }),
    getServerSession: (...args: unknown[]) => getServerSession(...args),
  };
});
import { prisma } from "../lib/prisma";
import { createToken, previewToken } from "../lib/tokens";
import { ApiError, MAX_PASSWORD_BYTES, fail, parseJsonBody, passwordWithinBcrypt } from "../lib/api";
import { checkPrompt } from "../lib/safety";
import { sniffContentType } from "../lib/media-type";
import { isPermanentProviderError } from "../lib/worker-errors";
import { hashBackupCode, useBackupCode, verifyBackupCode } from "../lib/twofa";
import { cleanStaleConcatDirs } from "../lib/video-concat";
import { POST as registerPOST } from "../app/api/register/route";
import { POST as resetPOST } from "../app/api/auth/reset-password/route";
import { POST as createKey } from "../app/api/account/keys/route";

// Pass 70: bcrypt stores at most the first 72 BYTES of a password, while the
// register/reset schemas accepted up to 100 UTF-16 units. The account's real
// password was therefore a PREFIX of the one the user chose: an account created
// with 97 characters signed in with the first 72 (probed end-to-end against a
// production build, and the first assertion below pins the bcrypt behaviour the
// whole finding rests on). New passwords are now capped at the real limit on the
// two WRITE paths; the re-auth paths keep accepting longer values so accounts
// created before the cap can still sign in and change it.

const EMAIL_DOMAIN = "@pass70.test";
let ipSeq = 0;
const runOctet = Math.floor(Math.random() * 250) + 1;

function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": `10.${runOctet}.${(ipSeq++ % 250) + 1}.1`,
    },
    body: JSON.stringify(body),
  });
}

const origVerifyAuto = process.env.EMAIL_VERIFY_AUTO;

beforeAll(async () => {
  // The success-path registration must not consume the hourly auth-mail budget
  // (nor print a live verification link into the suite log); the rejection
  // assertions never reach the send.
  process.env.EMAIL_VERIFY_AUTO = "1";
  await prisma.user.deleteMany({ where: { email: { contains: EMAIL_DOMAIN } } });
  await prisma.verificationToken.deleteMany({ where: { email: { contains: EMAIL_DOMAIN } } });
});

afterAll(async () => {
  if (origVerifyAuto) process.env.EMAIL_VERIFY_AUTO = origVerifyAuto;
  else delete process.env.EMAIL_VERIFY_AUTO;
  await prisma.user.deleteMany({ where: { email: { contains: EMAIL_DOMAIN } } });
  await prisma.verificationToken.deleteMany({ where: { email: { contains: EMAIL_DOMAIN } } });
  await prisma.$disconnect();
});

describe("pass 70 — bcrypt's 72-byte password limit", () => {
  it("counts UTF-8 bytes, not UTF-16 units", () => {
    expect(MAX_PASSWORD_BYTES).toBe(72);
    expect(passwordWithinBcrypt("a".repeat(72))).toBe(true);
    expect(passwordWithinBcrypt("a".repeat(73))).toBe(false);
    // 24 CJK characters are 72 bytes; 25 are 75 and would be truncated.
    expect(passwordWithinBcrypt("密".repeat(24))).toBe(true);
    expect(passwordWithinBcrypt("密".repeat(25))).toBe(false);
    // Astral characters are 4 bytes each.
    expect(passwordWithinBcrypt("😀".repeat(18))).toBe(true);
    expect(passwordWithinBcrypt("😀".repeat(19))).toBe(false);
  });

  it("pins the truncation the cap exists for (premise of the finding)", async () => {
    const full = "A".repeat(72) + "TAIL-THAT-BCRYPT-NEVER-STORES";
    const hash = await bcrypt.hash(full, 4);
    expect(await bcrypt.compare(full, hash)).toBe(true);
    // The 72-byte prefix authenticates the 97-character password.
    expect(await bcrypt.compare("A".repeat(72), hash)).toBe(true);
    // One byte short does not — the boundary is exactly 72.
    expect(await bcrypt.compare("A".repeat(71), hash)).toBe(false);
  });

  it("refuses a password over 72 UTF-8 bytes at registration", async () => {
    const over = await registerPOST(
      jsonRequest("http://localhost/api/register", {
        email: `over-ascii${EMAIL_DOMAIN}`,
        password: "a".repeat(64) + "b".repeat(9), // 73 bytes
      }),
    );
    expect(over.status).toBe(400);
    expect(await over.text()).toContain("at most 72 bytes");
    expect(await prisma.user.findUnique({ where: { email: `over-ascii${EMAIL_DOMAIN}` } })).toBeNull();

    const cjk = await registerPOST(
      jsonRequest("http://localhost/api/register", {
        email: `over-cjk${EMAIL_DOMAIN}`,
        password: "密".repeat(25), // 75 bytes, 25 UTF-16 units
      }),
    );
    expect(cjk.status).toBe(400);
    expect(await cjk.text()).toContain("at most 72 bytes");

    const atLimit = await registerPOST(
      jsonRequest("http://localhost/api/register", {
        email: `at-limit${EMAIL_DOMAIN}`,
        password: "a".repeat(72),
      }),
    );
    expect(atLimit.status).toBe(200);
    const created = await prisma.user.findUniqueOrThrow({
      where: { email: `at-limit${EMAIL_DOMAIN}` },
      select: { passwordHash: true },
    });
    expect(await bcrypt.compare("a".repeat(72), created.passwordHash)).toBe(true);
    expect(await bcrypt.compare("a".repeat(71), created.passwordHash)).toBe(false);
  });

  it("refuses a reset that would store a truncated password, and leaves the link usable", async () => {
    const email = `reset${EMAIL_DOMAIN}`;
    const oldHash = await bcrypt.hash("Old-password-123", 4);
    await prisma.user.create({ data: { email, passwordHash: oldHash } });
    const rawToken = await createToken(email, "reset-password");

    const over = await resetPOST(
      jsonRequest("http://localhost/api/auth/reset-password", {
        token: rawToken,
        password: "A".repeat(73),
      }),
    );
    expect(over.status).toBe(400);
    expect(await over.text()).toContain("at most 72 bytes");
    // The refusal must happen at validation, before the single-use token is
    // spent: the owner's mail must still work after a typo'd/oversized paste.
    expect((await previewToken("reset-password", rawToken)).ok).toBe(true);
    const unchanged = await prisma.user.findUniqueOrThrow({ where: { email }, select: { passwordHash: true } });
    expect(unchanged.passwordHash).toBe(oldHash);

    const ok = await resetPOST(
      jsonRequest("http://localhost/api/auth/reset-password", {
        token: rawToken,
        password: "B".repeat(72),
      }),
    );
    expect(ok.status).toBe(200);
    const rotated = await prisma.user.findUniqueOrThrow({ where: { email }, select: { passwordHash: true } });
    expect(await bcrypt.compare("B".repeat(72), rotated.passwordHash)).toBe(true);
    // The link is single-use and was spent by the successful reset.
    expect((await previewToken("reset-password", rawToken)).ok).toBe(false);
  });
});

describe("pass 70 — child-safety vocabulary", () => {
  // The video lane has NO output audit, so this list is its only gate. The
  // archetype words below returned ok while 儿童 裸 was blocked — the exact
  // asymmetry a hostile prompt relies on (probed through checkPrompt).
  const blocked = [
    "萝莉 裸",
    "正太 裸",
    "幼儿 裸",
    "中学生 裸",
    "女童 裸",
    "少女 裸",
    "少年 裸",
    "loli nude",
    "lolis nude",
    "shota nude",
    "shotas nude",
    "jailbait",
    "childlover",
    "child-lover",
    "child lover",
  ];
  for (const prompt of blocked) {
    it(`blocks ${prompt}`, () => {
      // Only "blocked" is asserted here: a phrase that also names an explicit
      // act ("loli nude") matches the earlier adult-content rule, which is the
      // first reason in the list. The child-safety classification is pinned
      // separately below, on prompts whose only vocabulary is the archetype.
      expect(checkPrompt(prompt).ok).toBe(false);
    });
  }

  for (const prompt of ["loli", "shota", "jailbait", "childlover", "child lover", "萝莉 裸", "正太 裸"]) {
    it(`classifies ${prompt} as child-safety`, () => {
      const result = checkPrompt(prompt);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("child-safety");
    });
  }

  // The rule is subject + explicit behaviour, and the archetype words are
  // ordinary in benign prompts. These must keep working.
  const allowed = [
    "lollipop on a table",
    "a grape and a sextant",
    "控制面板",
    "少女 在海边散步",
    "中学生 校服",
    "Lolita fashion editorial",
    // Ordinary beauty/character prompts that a bare 裸/性 subject rule would
    // have blocked once 少女/少年 joined it (their own explicit-terms rule is
    // what keeps 少女 裸 blocked).
    "少女 裸妆",
    "少女 裸色口红",
    "少女 个性穿搭",
    "少年 性格",
  ];
  for (const prompt of allowed) {
    it(`allows ${prompt}`, () => {
      expect(checkPrompt(prompt).ok).toBe(true);
    });
  }
});

describe("pass 70 — ISOBMFF brand recognition", () => {
  function ftyp(brand: string): Uint8Array {
    const b = Buffer.alloc(16);
    b.writeUInt32BE(24, 0);
    b.write("ftyp", 4, "latin1");
    b.write(brand, 8, "latin1");
    return b;
  }

  it("accepts every common major brand, not only isom", () => {
    for (const brand of ["isom", "mp42", "avc1", "M4V ", "iso5", "dash"]) {
      expect(sniffContentType(ftyp(brand)), brand).toBe("video/mp4");
    }
    expect(sniffContentType(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]))).toBe("video/webm");
    // A text/HTML body is still not a video container.
    expect(sniffContentType(Buffer.from("<html><body>blocked</body></html>"))).toBeNull();
  });
});

describe("pass 70 — only request bodies are classified as invalid-json", () => {
  it("parseJsonBody throws an ApiError(400), whatever the caller does with it", async () => {
    let caught: unknown;
    try {
      parseJsonBody("{not json");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(400);
    const res = fail(caught);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "invalid-json" });
  });

  it("an unrelated SyntaxError is a masked 500, not a client error", async () => {
    // A route's own JSON.parse of a corrupted DB column used to reach fail()
    // as a bare SyntaxError and answer a permanent 400 invalid-json with no
    // incident. It must now be the unexpected path.
    const res = fail(new SyntaxError("Unexpected token in stored row"));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ ok: false, error: "internal-error" });
  });

  it("refuses a NUL in an object KEY as well as in a value", () => {
    expect(() => parseJsonBody('{"a\\u0000b":1}')).toThrow(/NUL/);
    expect(() => parseJsonBody('{"a":"b\\u0000c"}')).toThrow(/NUL/);
    // A well-formed body with an ordinary key still parses.
    expect(parseJsonBody('{"ok":1}')).toEqual({ ok: 1 });
  });
});

describe("pass 70 — a recovery code is not burned by a refused erasure", () => {
  it("verifies a backup code without marking it used", async () => {
    const email = `backup${EMAIL_DOMAIN}`;
    const user = await prisma.user.create({
      data: { email, passwordHash: "x".repeat(60) },
    });
    const code = "ABCDEF0123456789ABCD";
    await prisma.backupCode.create({ data: { userId: user.id, codeHash: hashBackupCode(code) } });
    try {
      expect(await verifyBackupCode(user.id, code)).toBe(true);
      // Still available: a 503 from the erasure's storage sweep must leave the
      // account (and its recovery set) exactly as it was.
      expect(await prisma.backupCode.count({ where: { userId: user.id, usedAt: null } })).toBe(1);
      // The single-use consumer still works on the same code exactly once.
      expect(await useBackupCode(user.id, code)).toBe(true);
      expect(await useBackupCode(user.id, code)).toBe(false);
      expect(await verifyBackupCode(user.id, code)).toBe(false);
    } finally {
      await prisma.backupCode.deleteMany({ where: { userId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  });
});

describe("pass 70 — stale concat temp dirs are reaped at boot", () => {
  it("removes an old pdconcat dir and keeps a fresh one", async () => {
    const oldDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pdconcat-testold-"));
    const newDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pdconcat-testnew-"));
    const old = new Date(Date.now() - 7 * 60 * 60 * 1000);
    await fsp.utimes(oldDir, old, old);
    try {
      await cleanStaleConcatDirs();
      await expect(fsp.stat(oldDir)).rejects.toThrow();
      await expect(fsp.stat(newDir)).resolves.toBeTruthy();
    } finally {
      await fsp.rm(oldDir, { recursive: true, force: true }).catch(() => undefined);
      await fsp.rm(newDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});

describe("pass 70 — a key mint refused by the cap does not spend the second factor", () => {
  it("leaves the backup code usable when the account is already at 10 active keys", async () => {
    const email = `keycap${EMAIL_DOMAIN}`;
    const password = "Correct-horse-12345";
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash: await bcrypt.hash(password, 10),
        emailVerified: new Date(),
        totpEnabled: true,
        totpSecret: "JBSWY3DPEHPK3PXP",
      },
    });
    const code = "ABCDEF0123456789ABCD";
    await prisma.backupCode.create({ data: { userId: user.id, codeHash: hashBackupCode(code) } });
    await prisma.apiKey.createMany({
      data: Array.from({ length: 10 }, (_, i) => ({
        userId: user.id,
        name: `k${i}`,
        keyHash: `p70-hash-${user.id}-${i}`,
        prefix: `pd_live_p70${i}`,
      })),
    });
    try {
      getServerSession.mockResolvedValue({
        user: { id: user.id, sv: user.sessionVersion, totpPending: false },
      });
      const res = await createKey(
        jsonRequest("http://localhost/api/account/keys", { name: "one-too-many", password, backupCode: code }),
      );
      expect(res.status).toBe(409);
      // The whole point: the single-use code was NOT consumed before the cheap
      // precondition refused the mint (the transaction's re-check stays as the
      // invariant; this is the ordering fix).
      expect(await verifyBackupCode(user.id, code)).toBe(true);
    } finally {
      getServerSession.mockReset();
      await prisma.apiKey.deleteMany({ where: { userId: user.id } });
      await prisma.backupCode.deleteMany({ where: { userId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  });
});

describe("pass 70 — provider fault classification", () => {
  it("treats empty and non-video payloads as terminal, transients as retryable", () => {
    expect(isPermanentProviderError("empty-image: the supplied image decoded to zero bytes")).toBe(true);
    expect(isPermanentProviderError("not-a-video: the provider's video URL did not return an MP4/WebM container")).toBe(true);
    expect(isPermanentProviderError("socket hang up")).toBe(false);
    expect(isPermanentProviderError("503 Service Unavailable")).toBe(false);
  });
});
