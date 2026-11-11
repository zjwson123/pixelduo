import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFile } from "child_process";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import http from "http";

// The route-level cases below need a session; the rest of auth is real. Same
// harness as credential-revocation.test.ts.
const getServerSession = vi.fn();
vi.mock("next-auth", () => ({
  getServerSession: (...args: unknown[]) => getServerSession(...args),
}));

const { prisma } = await import("../lib/prisma");
const { getStorage } = await import("../lib/storage");
const { createMediaJob, checkpointJobArtifact } = await import("../lib/queue");
const { grantCreditsTx, addBillingMonth } = await import("../lib/ledger");
const { scrubSentryEvent, _sensitiveQueryParamForTests } = await import("../lib/sentry-scrub");
const { passwordReauthRefusal } = await import("../lib/auth");
const { decodeIpv4Literal, hostIsPublic, readBodyCapped } = await import("../lib/store");
const { looksLikeIsoBmffMedia, concatVideos, concatFfmpegArgs } = await import("../lib/video-concat");
const { POST: twoFactorSetup } = await import("../app/api/2fa/setup/route");
const { POST: adminCredits } = await import("../app/api/admin/users/[id]/credits/route");

const stamp = Date.now();
const madeEmails: string[] = [];

async function makeUser(label: string, extra: Record<string, unknown> = {}) {
  const email = `p17-${label}-${stamp}@test.dev`;
  madeEmails.push(email);
  // passwordHash is not nullable; a placeholder is fine except where a case
  // needs the OAuth-shaped 64-hex one explicitly.
  return prisma.user.create({ data: { email, name: label, passwordHash: "p17-placeholder", ...extra } });
}

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { in: madeEmails } } });
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// 1. A superseded artifact is retired AFTER the checkpoint that replaces it
// ---------------------------------------------------------------------------
describe("video artifact supersession (pass 17)", () => {
  let userId: string;
  beforeAll(async () => {
    const user = await makeUser("artifact", { emailVerified: new Date() });
    userId = user.id;
    await prisma.$transaction((tx) => grantCreditsTx(tx, user.id, "SIGNUP_BONUS", 500, null));
  });

  it("never deletes an object the delivery already committed", async () => {
    const storage = getStorage();
    const { job } = await createMediaJob({
      userId,
      model: "seedance",
      mediaType: "video",
      quality: "standard",
      count: 1,
      prompt: "supersede-vs-delivered",
      durationSec: 5,
    });
    // The state a losing attempt sees: it snapshotted `priorKey` while the job
    // was in flight, and by the time it writes its own artifact the job has been
    // DELIVERED by a competing attempt — status done, Image row naming the very
    // object the snapshot holds.
    const delivered = `img/p17-delivered-${stamp}.mp4`;
    const losing = `img/p17-losing-${stamp}.mp4`;
    await storage.put(delivered, Buffer.from("delivered"));
    await storage.put(losing, Buffer.from("losing"));
    await prisma.job.update({ where: { id: job.id }, data: { status: "done", images: JSON.stringify([delivered]) } });
    await prisma.image.create({
      data: {
        userId,
        jobId: job.id,
        url: delivered,
        model: "seedance",
        quality: "standard",
        prompt: "supersede-vs-delivered",
        credits: 10,
      },
    });

    // The guarded write must be refused (the job left the queue) ...
    // The id only satisfies the fence: this write is refused by the older half
    // of the CAS — the job left the queue (status done).
    await expect(checkpointJobArtifact(job.id, delivered, losing, "p17-w")).rejects.toThrow(/left the queue/);
    // ... and the refused write must not have retired anything. Deleting the
    // superseded key BEFORE the write made this destroy the delivered file: the
    // job stayed `done` with an Image row pointing at an object that no longer
    // existed — paid in full, gallery 404s, /api/files gone, no repair path.
    expect(await storage.get(delivered)).not.toBeNull();
  });

  it("still retires the superseded object on a normal checkpoint", async () => {
    const storage = getStorage();
    const { job } = await createMediaJob({
      userId,
      model: "seedance",
      mediaType: "video",
      quality: "standard",
      count: 1,
      prompt: "supersede-normal",
      durationSec: 5,
    });
    await prisma.job.update({ where: { id: job.id }, data: { status: "polling", worker: "p17-w" } });
    const first = `img/p17-first-${stamp}.mp4`;
    const second = `img/p17-second-${stamp}.mp4`;
    await storage.put(first, Buffer.from("one"));
    await storage.put(second, Buffer.from("two"));
    await checkpointJobArtifact(job.id, null, first, "p17-w");
    await checkpointJobArtifact(job.id, first, second, "p17-w");
    expect(await storage.get(first)).toBeNull();
    expect(await storage.get(second)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. ffmpeg is only ever handed ISO-BMFF media
// ---------------------------------------------------------------------------
describe("concat input guard (pass 17)", () => {
  const ftyp = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom", "latin1"), Buffer.alloc(16)]);

  it("accepts ISO-BMFF media and refuses anything a demuxer could treat as a playlist", () => {
    expect(looksLikeIsoBmffMedia(ftyp)).toBe(true);
    // Legal openers other than ftyp (encoders do emit these).
    for (const box of ["styp", "moov", "wide", "free", "mdat"]) {
      expect(looksLikeIsoBmffMedia(Buffer.concat([Buffer.from([0, 0, 0, 8]), Buffer.from(box, "latin1")]))).toBe(true);
    }
    // The shapes that matter: a playlist/xml payload probes as a demuxer that can
    // FETCH (hls/dash), and those bytes must never reach ffmpeg from here.
    expect(looksLikeIsoBmffMedia(Buffer.from("#EXTM3U\n#EXT-X-TARGETDURATION:1\n"))).toBe(false);
    expect(looksLikeIsoBmffMedia(Buffer.from('<?xml version="1.0"?><MPD>'))).toBe(false);
    expect(looksLikeIsoBmffMedia(Buffer.from("{\"json\":1}"))).toBe(false);
    expect(looksLikeIsoBmffMedia(Buffer.alloc(0))).toBe(false);
    expect(looksLikeIsoBmffMedia(Buffer.from("ftyp"))).toBe(false); // too short to be a box
  });

  it("passes a protocol whitelist to ffmpeg, so a nested demuxer cannot fetch", () => {
    // The flag is unobservable end to end: the payload shapes that would make
    // ffmpeg reach the network (an HLS playlist) are already refused by the
    // ISO-BMFF guard and, independently, by ffmpeg's own extension-matched
    // probing for a *.mp4 name. It is still the load-bearing defence for any
    // future payload that probes as hls/dash, so a refactor must not drop it.
    const args = concatFfmpegArgs("/tmp/list.txt", "/tmp/out.mp4");
    const i = args.indexOf("-protocol_whitelist");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe("file,crypto,data");
    // It has to precede the input it applies to (and thus the nested opens).
    expect(i).toBeLessThan(args.indexOf("-i"));
  });

  it("does not invoke ffmpeg at all for a non-mp4 payload", async () => {
    // A payload that ffmpeg WOULD happily parse (an MPEG-TS stream, whose probe
    // scores on 0x47 sync bytes regardless of the file's name) is still refused,
    // because the guard runs before the process is spawned.
    const ts = Buffer.alloc(940, 0x47);
    expect(await concatVideos(ftyp, ts)).toBeNull();
    expect(await concatVideos(ts, ftyp)).toBeNull();
  });

  it("never lets a playlist payload reach a network sink, and keeps real concat working", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "p17concat-"));
    const haveFfmpeg = await new Promise<boolean>((resolve) =>
      execFile("ffmpeg", ["-version"], (err) => resolve(!err)),
    );
    const hits: string[] = [];
    const sink = http.createServer((req, res) => {
      hits.push(req.url ?? "/");
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => sink.listen(0, "127.0.0.1", r));
    const port = (sink.address() as { port: number }).port;
    try {
      const playlist = Buffer.from(
        `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXTINF:1.0,\nhttp://127.0.0.1:${port}/leak.ts\n#EXT-X-ENDLIST\n`,
      );
      // The source clip is a real mp4 when ffmpeg is available, so the ONLY
      // reason this can fail is the playlist payload — which is the point.
      let source = ftyp;
      if (haveFfmpeg) {
        const a = path.join(dir, "a.mp4");
        await new Promise<void>((resolve, reject) =>
          execFile("ffmpeg", ["-y", "-f", "lavfi", "-i", "testsrc=d=1:s=64x64", "-c:v", "libx264", "-pix_fmt", "yuv420p", a],
            (err) => (err ? reject(err) : resolve())),
        );
        source = await fsp.readFile(a);
      }
      expect(await concatVideos(source, playlist)).toBeNull();
      await new Promise((r) => setTimeout(r, 250));
      expect(hits).toEqual([]);
    } finally {
      sink.close();
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("still concatenates two real clips (the protocol whitelist must not break it)", async () => {
    const haveFfmpeg = await new Promise<boolean>((resolve) =>
      execFile("ffmpeg", ["-version"], (err) => resolve(!err)),
    );
    if (!haveFfmpeg) return; // CI without ffmpeg: the guard cases above still ran
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "p17concat-ok-"));
    try {
      const clips: Buffer[] = [];
      for (const name of ["a.mp4", "b.mp4"]) {
        const p = path.join(dir, name);
        await new Promise<void>((resolve, reject) =>
          execFile("ffmpeg", ["-y", "-f", "lavfi", "-i", "testsrc=d=1:s=64x64", "-c:v", "libx264", "-pix_fmt", "yuv420p", p],
            (err) => (err ? reject(err) : resolve())),
        );
        clips.push(await fsp.readFile(p));
      }
      const merged = await concatVideos(clips[0], clips[1]);
      expect(merged).not.toBeNull();
      expect(merged!.length).toBeGreaterThan(clips[0].length / 2);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Sentry never ships a reset/verify token
// ---------------------------------------------------------------------------
describe("Sentry payload scrubbing (pass 17)", () => {
  it("redacts credential-bearing query parameters anywhere in the event", () => {
    const token = "b7f3c1d9e0a4".repeat(2);
    const event = scrubSentryEvent({
      event_id: "x",
      message: `request to /reset-password?token=${token} failed`,
      request: {
        url: `https://pixelduo.ai/reset-password?token=${token}&lang=en`,
        query_string: `token=${token}`,
        headers: { referer: `https://pixelduo.ai/verify-email?token=${token}` },
      },
      breadcrumbs: [
        { category: "navigation", data: { from: "/login", to: `/verify-email?token=${token}` } },
        { category: "fetch", data: { url: `/api/auth/reset-password?code=${token}` } },
      ],
      contexts: { trace: { span: `/reset-password?token=${token}` } },
    });

    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain(token);
    expect(serialized).toContain("[Filtered]");
    // The path survives — a report has to stay useful.
    expect(serialized).toContain("/reset-password");
    expect(serialized).toContain("lang=en");
  });

  it("leaves ordinary URLs and event data untouched", () => {
    const event = {
      request: { url: "https://pixelduo.ai/studio?tab=video&page=2" },
      message: "TypeError: cannot read properties of undefined",
      extra: { model: "gpt-image-2", count: 4 },
    };
    expect(scrubSentryEvent(event)).toEqual(event);
    // The pattern is anchored on a query-parameter position, so a path segment
    // that merely contains a keyword is not redacted.
    expect(_sensitiveQueryParamForTests.test("/api/files/img/1234.png")).toBe(false);
  });

  it("is wired into both SDK configs (an unscrubbed client is where the token lives)", async () => {
    const [client, server] = await Promise.all([
      fsp.readFile(path.join(process.cwd(), "instrumentation-client.ts"), "utf8"),
      fsp.readFile(path.join(process.cwd(), "sentry.server.config.ts"), "utf8"),
    ]);
    for (const source of [client, server]) {
      expect(source).toContain("scrubSentryEvent");
      expect(source).toContain("beforeSend:");
      expect(source).toContain("beforeSendTransaction:");
    }
  });
});

// ---------------------------------------------------------------------------
// 4. OAuth-only accounts get an instruction, not a permanent "wrong password"
// ---------------------------------------------------------------------------
describe("re-auth on passwordless accounts (pass 17)", () => {
  it("refuses with a next step for a placeholder hash and allows a real one", () => {
    expect(passwordReauthRefusal("$2a$10$abcdefghijklmnopqrstuv")).toBeNull();
    const refusal = passwordReauthRefusal("a".repeat(64));
    expect(refusal).toBeInstanceOf(Error);
    expect(refusal!.message.startsWith("cannot-reauth-oauth:")).toBe(true);
  });

  it("answers 400 with that instruction on a re-auth route, without burning an attempt", async () => {
    // An OAuth-created account: the placeholder lib/auth.ts stores.
    const user = await makeUser("oauth", { emailVerified: new Date(), passwordHash: "f".repeat(64) });
    getServerSession.mockResolvedValue({
      user: { id: user.id, sv: user.sessionVersion, totpPending: false },
    });
    const req = new Request("http://localhost/api/2fa/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "anything-at-all" }),
    });
    const res = await twoFactorSetup(req);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("cannot-reauth-oauth");
    expect(body.error).toContain("Forgot password");
    // No pending secret was created, and no password attempt was reserved.
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.totpPendingSecret).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. Admin grants stay attributed to the acting admin
// ---------------------------------------------------------------------------
// A "you may not grant to yourself" check was considered and rejected: an admin
// can mint to any account, so it closes no boundary while breaking the
// single-operator flow (and e2e/admin.spec.ts). What has to hold is that a grant
// is attributable afterwards — that is the control.
describe("admin credit attribution (pass 17)", () => {
  it("records who granted, even when the operator grants to their own account", async () => {
    const admin = await makeUser("admin", { emailVerified: new Date(), role: "admin" });
    await prisma.$transaction((tx) => grantCreditsTx(tx, admin.id, "ADMIN", 50, null));
    getServerSession.mockResolvedValue({
      user: { id: admin.id, sv: admin.sessionVersion, totpPending: false },
    });
    const res = await adminCredits(
      new Request("http://localhost/api/admin/users/x/credits", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ delta: 100, note: "e2e compensation" }),
      }),
      { params: Promise.resolve({ id: admin.id }) },
    );
    expect(res.status).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: admin.id } })).credits).toBe(150);

    const grant = await prisma.creditGrant.findFirstOrThrow({
      where: { userId: admin.id, source: "ADMIN" },
      orderBy: { createdAt: "desc" },
    });
    expect(grant.refType).toBe("admin");
    expect(grant.refId).toBe(admin.id);
    const entry = await prisma.ledgerEntry.findFirstOrThrow({
      where: { userId: admin.id, type: "ADMIN" },
      orderBy: { createdAt: "desc" },
    });
    expect(entry.refType).toBe("admin");
    expect(entry.refId).toBe(admin.id);
    expect(entry.note).toBe("e2e compensation");
    expect(entry.creditsDelta).toBe(100);
    // Non-expiring: compensation must not lapse like a cycle grant.
    expect(grant.expiresAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 6. Renewals and SSRF literal decoding on month/format boundaries
// ---------------------------------------------------------------------------
describe("billing month and IPv4 literals (pass 17)", () => {
  it("clamps a month-end renewal to the target month's last day", () => {
    // UTC fixtures, because the arithmetic is UTC-based since pass 30. Local
    // constructors made these assertions TZ-dependent: they passed on a UTC
    // host and on this +08 one they merely passed for a different reason (both
    // sides shifted together), while the function itself answered a different
    // renewal INSTANT per host TZ for the same stored anchor.
    const at = (y: number, m: number, d: number, h = 12, min = 30) => new Date(Date.UTC(y, m - 1, d, h, min));
    // Jan 31 → Feb 28 (2026 is not a leap year). setMonth alone rolled this to
    // March 3 — three free days of plan and quota, every month-end renewal.
    expect(addBillingMonth(at(2026, 1, 31))).toEqual(at(2026, 2, 28));
    expect(addBillingMonth(at(2028, 1, 31))).toEqual(at(2028, 2, 29)); // leap year
    expect(addBillingMonth(at(2026, 3, 31))).toEqual(at(2026, 4, 30));
    expect(addBillingMonth(at(2026, 5, 31))).toEqual(at(2026, 6, 30));
    // The ordinary case is untouched, and the time of day survives.
    expect(addBillingMonth(at(2026, 1, 15))).toEqual(at(2026, 2, 15));
    expect(addBillingMonth(at(2026, 12, 15))).toEqual(at(2027, 1, 15));
    expect(addBillingMonth(at(2026, 1, 31, 23, 59))).toEqual(at(2026, 2, 28, 23, 59));
  });

  it("decodes single-part IPv4 literals instead of falling through", () => {
    expect(decodeIpv4Literal("2130706433")).toBe("127.0.0.1");
    expect(decodeIpv4Literal("0x7f000001")).toBe("127.0.0.1");
    expect(decodeIpv4Literal("3232235777")).toBe("192.168.1.1");
    // The longer forms keep working.
    expect(decodeIpv4Literal("127.1")).toBe("127.0.0.1");
    expect(decodeIpv4Literal("0x7f.1")).toBe("127.0.0.1");
    expect(decodeIpv4Literal("0177.0.0.1")).toBe("127.0.0.1");
    expect(decodeIpv4Literal("example.com")).toBeNull();
  });

  it("keeps the literal forms private through hostIsPublic", async () => {
    for (const host of ["2130706433", "0x7f000001", "3232235777", "127.1", "169.254.169.254"]) {
      expect(await hostIsPublic(host)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 7. The moderation audit refuses to hand libvips a non-raster payload
// ---------------------------------------------------------------------------
describe("moderation downscale input (pass 17)", () => {
  it("refuses a non-raster payload instead of handing it to libvips", async () => {
    const { shrinkForAudit } = await import("../lib/safety");
    // Under the 20MP ceiling, so nothing else can be the reason it fails: an
    // SVG whose only "problem" is what it is. Pre-fix this resolved — sharp
    // parsed it through librsvg (the same parser lib/watermark.ts refuses on the
    // delivery path) — and the audit then reported a verdict on it.
    const svg = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect/></svg>');
    await expect(shrinkForAudit(svg)).rejects.toThrow(/unsupported-image-format/);
    // A real raster still shrinks.
    const { default: sharp } = await import("sharp");
    const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#fff" } })
      .png()
      .toBuffer();
    expect((await shrinkForAudit(png)).length).toBeGreaterThan(0);
  });

  it("fail-closes the audit for an SVG payload instead of reaching librsvg", async () => {
    const { analyzeImage } = await import("../lib/safety");
    const { _setMailerForTests } = await import("../lib/mail");
    _setMailerForTests(null);
    const prevModeration = process.env.IMAGE_MODERATION;
    const prevKey = process.env.VISION_MODERATION_API_KEY;
    const prevBase = process.env.VISION_MODERATION_BASE_URL;
    // Big enough to take the downscale branch (>1MB), raster-less content.
    const svg = Buffer.from(
      `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="9000" height="9000">${"<rect/>".repeat(200000)}</svg>`,
    );
    expect(svg.length).toBeGreaterThan(1024 * 1024);
    const key = `img/p17-svg-${stamp}.png`;
    await getStorage().put(key, svg, "image/png");
    process.env.IMAGE_MODERATION = "1";
    process.env.VISION_MODERATION_API_KEY = "mod-key";
    process.env.VISION_MODERATION_BASE_URL = "https://vision.example.invalid/v1";
    try {
      const audit = await analyzeImage(key);
      // Unavailable — and therefore a refused delivery, not a silent pass.
      expect(audit.checked).toBe(false);
      expect(audit.unavailable).toBe(true);
    } finally {
      if (prevModeration === undefined) delete process.env.IMAGE_MODERATION;
      else process.env.IMAGE_MODERATION = prevModeration;
      if (prevKey === undefined) delete process.env.VISION_MODERATION_API_KEY;
      else process.env.VISION_MODERATION_API_KEY = prevKey;
      if (prevBase === undefined) delete process.env.VISION_MODERATION_BASE_URL;
      else process.env.VISION_MODERATION_BASE_URL = prevBase;
      await getStorage().delete(key).catch(() => undefined);
    }
  });
});

// ---------------------------------------------------------------------------
// 8. The streaming read cap used by the case importer
// ---------------------------------------------------------------------------
describe("readBodyCapped (pass 17)", () => {
  it("refuses a chunked body that exceeds the cap, not just a declared one", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 10; i++) controller.enqueue(new Uint8Array(1024));
        controller.close();
      },
    });
    const res = new Response(stream, { headers: { "content-type": "image/jpeg" } });
    await expect(readBodyCapped(res, 4096)).rejects.toThrow(/download-too-large/);
    const small = new Response(new Uint8Array(100));
    expect((await readBodyCapped(small, 4096)).length).toBe(100);
  });

  it("is what the case importer reads upstream images with", async () => {
    // The cap-after-buffering shape (`res.arrayBuffer()` then a length check)
    // allocated whatever the upstream sent; the streaming helper is the fix, and
    // this pins that the script uses it rather than checking after the fact.
    // Pass 59 moved the importer onto fetchPublicBuffer, which streams through
    // the same readBodyCapped under the same maxBytes cap — and also validates
    // each redirect hop (the global fetch followed 20 of them unguarded, then
    // published the bytes as a shared Template image).
    const source = await fsp.readFile(path.join(process.cwd(), "scripts/import-cases.ts"), "utf8");
    expect(source).toContain("fetchPublicBuffer(url, { timeoutMs: 30_000, maxBytes: MAX_CASE_BYTES })");
    expect(source).not.toContain("await fetch(");
    // No whole-body read: the cap has to be enforced while the stream arrives.
    expect(source).not.toMatch(/await res\.arrayBuffer\(\)/);
  });
});
