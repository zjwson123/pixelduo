import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { prisma } from "../lib/prisma";
import { grantCreditsTx } from "../lib/ledger";
import { getStorage, newStorageKey } from "../lib/storage";
import {
  checkpointJobArtifact,
  checkpointJobProgress,
  claimNextJob,
  completeJob,
  createMediaJob,
  failJob,
  recoverStuckJobs,
  setJobPolling,
} from "../lib/queue";

// Pass 37. Four domain audits (money, queue/worker, HTTP surface, ops) over
// 191ed36, and every case below was reproduced with a probe before it was
// fixed. The classes: a delivery the row's holder had lost, an attempt booked
// twice by a zombie, a restore-drill guard a trailing slash walked past, a
// rotation that deleted the snapshot it had just written, an image gate that
// could not fail, mails pointing at the vendor's domain, and a content filter
// that Unicode punctuation could still spell past.

const REPO = path.resolve(__dirname, "..");
const stamp = Date.now();
let seq = 0;

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO, rel), "utf8");
}

async function makeUser(tag: string, credits = 1000) {
  const user = await prisma.user.create({
    data: {
      email: `p37-${tag}-${stamp}-${seq++}@test.dev`,
      passwordHash: "x",
      emailVerified: new Date(),
    },
  });
  if (credits > 0) {
    await prisma.$transaction((tx) => grantCreditsTx(tx, user.id, "SIGNUP_BONUS", credits, null));
  }
  return user;
}

async function makeVideoJob(userId: string, tag: string) {
  const { job } = await createMediaJob({
    userId,
    model: "seedance",
    mediaType: "video",
    quality: "standard",
    count: 1,
    prompt: `p37 ${tag}`,
    durationSec: 5,
    idempotencyKey: `p37-${tag}-${stamp}-${seq++}`,
  });
  return job;
}

// Test files share one database and several call the GLOBAL claim/sweep
// selectors (claimNextJob's oldest-due pick, recoverStuckJobs' ORDER BY id
// LIMIT 20 batch). Rows another file created concurrently are therefore ahead
// of ours, or push ours out of the batch — the same flake pass 16/30 hit and
// fixed by parking. `nextAttemptAt`/`heartbeatAt` are saved and restored,
// never the status: a row whose status this file did not set is not ours to
// move.
async function parkQueuedAndPolling(excludeId: string) {
  const others = await prisma.job.findMany({
    where: { status: { in: ["queued", "polling"] }, id: { not: excludeId } },
    select: { id: true, nextAttemptAt: true },
  });
  if (others.length) {
    await prisma.job.updateMany({
      where: { id: { in: others.map((o) => o.id) } },
      data: { nextAttemptAt: new Date(Date.now() + 3_600_000) },
    });
  }
  return others;
}

async function unpark(rows: Array<{ id: string; nextAttemptAt: Date | null }>) {
  for (const r of rows) {
    await prisma.job
      .updateMany({ where: { id: r.id }, data: { nextAttemptAt: r.nextAttemptAt } })
      .catch(() => undefined);
  }
}

async function parkLiveRows(excludeId: string) {
  const others = await prisma.job.findMany({
    where: { status: { in: ["running", "polling"] }, id: { not: excludeId } },
    select: { id: true, heartbeatAt: true, startedAt: true },
  });
  const future = new Date(Date.now() + 3_600_000);
  if (others.length) {
    await prisma.job.updateMany({
      where: { id: { in: others.map((o) => o.id) } },
      data: { heartbeatAt: future, startedAt: future },
    });
  }
  return others;
}

afterAll(async () => {
  const users = await prisma.user.findMany({
    where: { email: { contains: `p37-${stamp}` } },
    select: { id: true },
  });
  const ids = users.map((u) => u.id);
  if (ids.length) {
    await prisma.image.deleteMany({ where: { userId: { in: ids } } });
    await prisma.job.deleteMany({ where: { userId: { in: ids } } });
    await prisma.ledgerEntry.deleteMany({ where: { userId: { in: ids } } });
    await prisma.creditGrant.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// 1. Queue: exactly one holder can deliver, and only while it still holds
// ---------------------------------------------------------------------------
describe("pass 37 — a delivery whose attempt lost the row is refused", () => {
  // The probed harm: W1 holds the poll lease, stores K1, stalls past the lease;
  // W2 claims the poll (a takeover always rewrites `worker`), stores K2 and its
  // checkpointJobArtifact(K1 → K2) deletes K1 — reclaimStoredArtifact's only
  // ownership witness is an Image row, and none can exist for a delivery that
  // has not committed. W1 wakes and completeJob used to accept (the CAS looked
  // at the status alone): the job ended `done`, credits settled, and the
  // delivered key had just been deleted — no retry, no refund, nothing repairs
  // it. Pre-fix this file's first case measured status=done with the delivered
  // object gone; with the fence the zombie is refused and the holder delivers.
  it("refuses the stalled attempt and lets the holder deliver its own object", async () => {
    const user = await makeUser("takeover");
    const storage = getStorage();
    const job = await makeVideoJob(user.id, "takeover");
    const W1 = `p37-takeover-w1-${stamp}`;
    const W2 = `p37-takeover-w2-${stamp}`;

    await prisma.job.update({
      where: { id: job.id },
      data: { status: "running", worker: W1, startedAt: new Date(), heartbeatAt: new Date() },
    });
    await setJobPolling(job.id, "task-takeover", W1);
    await prisma.job.update({ where: { id: job.id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });

    // W1 stores its deliverable and checkpoints it.
    const K1 = `img/p37-k1-${stamp}.mp4`;
    await storage.put(K1, Buffer.from("w1"), "video/mp4");
    await checkpointJobArtifact(job.id, null, K1, W1);

    // The lease lapses (no reaper needed: claimNextJob's due predicate is the
    // lease) and W2 takes the poll over. Lane 1 is tried first and the other
    // files' queued rows are ahead of ours, so park them.
    const parked = await parkQueuedAndPolling(job.id);
    let claimed: Awaited<ReturnType<typeof claimNextJob>> = null;
    try {
      claimed = await claimNextJob(W2);
    } finally {
      await unpark(parked);
    }
    expect(claimed?.id).toBe(job.id);
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).worker).toBe(W2);

    const K2 = `img/p37-k2-${stamp}.mp4`;
    await storage.put(K2, Buffer.from("w2"), "video/mp4");
    await checkpointJobArtifact(job.id, K1, K2, W2);
    // K1 is genuinely superseded and gone — that part is correct.
    expect(await storage.get(K1)).toBeNull();

    // The zombie's late delivery: refused, and it settles nothing.
    await expect(
      completeJob(job.id, [{ url: K1, model: "seedance", quality: "standard", credits: 70, prompt: "z" }], W1),
    ).rejects.toThrow(/job-not-runnable/);
    const mid = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(mid.status).toBe("polling");
    expect(await prisma.image.count({ where: { jobId: job.id } })).toBe(0);

    // The holder delivers — the job ends `done` with a live object.
    await completeJob(job.id, [{ url: K2, model: "seedance", quality: "standard", credits: 70, prompt: "z" }], W2);
    const done = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(done.status).toBe("done");
    expect(JSON.parse(done.images ?? "[]")).toEqual([K2]);
    expect(await storage.get(K2)).not.toBeNull();
    expect(await prisma.image.count({ where: { jobId: job.id } })).toBe(1);

    await storage.delete(K2).catch(() => undefined);
  });

  // The fence is a runtime requirement, not only a type: Prisma DROPS an
  // `undefined` field from a `where`, so a JavaScript caller that omits the id
  // would silently get the unfenced CAS back.
  it("refuses a delivery with no holder id instead of dropping the fence", async () => {
    const user = await makeUser("noholder");
    const job = await makeVideoJob(user.id, "noholder");
    await prisma.job.update({ where: { id: job.id }, data: { status: "polling", worker: "p37-w" } });
    const bare = completeJob as unknown as (a: string, b: unknown[], c?: string) => Promise<unknown>;
    await expect(
      bare(job.id, [{ url: "img/p37-none.mp4", model: "seedance", quality: "standard", credits: 1, prompt: "z" }]),
    ).rejects.toThrow(/complete-job-without-holder/);
    const row = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(row.status).toBe("polling");
  });

  it("fences the checkpoint writers on the holder too", async () => {
    const user = await makeUser("ckpt-fence");
    const job = await makeVideoJob(user.id, "ckpt-fence");
    await prisma.job.update({ where: { id: job.id }, data: { status: "polling", worker: "p37-holder" } });

    await checkpointJobProgress(job.id, [{ key: "img/p37-held.mp4" }], "p37-holder");
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).images).toContain("p37-held.mp4");

    // A zombie's write is refused (JOB_ABANDONED is what tells the worker to
    // stop the attempt and take its own objects back out), and it does not
    // clobber the holder's checkpoint.
    await expect(
      checkpointJobProgress(job.id, [{ key: "img/p37-zombie.mp4" }], "p37-zombie"),
    ).rejects.toThrow(/job-abandoned/);
    const row = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(row.images).toContain("p37-held.mp4");
    expect(row.images).not.toContain("p37-zombie.mp4");

    const ckpt = checkpointJobProgress as unknown as (a: string, b: unknown, c?: string) => Promise<void>;
    await expect(ckpt(job.id, [{ key: "x" }])).rejects.toThrow(/checkpoint-without-holder/);
  });

  it("a reaped holder's late failure does not book a second attempt", async () => {
    // The sweep's retry requeue KEEPS the holder's id (pass 36 relies on that so
    // a waking phase-1 zombie can still record the task it already billed), so
    // the `worker` fence alone matched the zombie's late failJob and charged the
    // same physical attempt twice — at the last attempt that is the TERMINAL
    // branch, failing and refunding a job the sweep had just granted a retry
    // (probed: attempts 1 → 2 on one attempt; and the terminal variant).
    const user = await makeUser("reap-double");
    const job = await makeVideoJob(user.id, "reap-double");
    const W = `p37-reap-${stamp}`;
    await prisma.job.update({
      where: { id: job.id },
      data: {
        status: "running",
        worker: W,
        attempts: 1,
        maxAttempts: 3,
        // Heartbeat far in the past: the sweep's own predicate reads it.
        heartbeatAt: new Date(Date.now() - 10 * 60_000),
        startedAt: new Date(Date.now() - 10 * 60_000),
      },
    });

    // The sweep's batch is global (ORDER BY id LIMIT 20): park the other
    // suites' live rows so none of them is reaped and ours cannot be pushed
    // out of the batch (the pass-30 pattern).
    const parkedLive = await parkLiveRows(job.id);
    let swept = 0;
    try {
      swept = await recoverStuckJobs();
    } finally {
      for (const p of parkedLive) {
        await prisma.job
          .updateMany({ where: { id: p.id }, data: { heartbeatAt: p.heartbeatAt, startedAt: p.startedAt } })
          .catch(() => undefined);
      }
    }
    expect(swept).toBeGreaterThanOrEqual(1);
    const parked = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(parked.status).toBe("queued");
    expect(parked.attempts).toBe(2); // the sweep's own single booking

    // The zombie wakes and fails the attempt it was running.
    await failJob(job.id, "zombie: download failed", { worker: W });
    const after = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.status).toBe("queued"); // still the sweep's retry
    expect(after.attempts).toBe(2); // not 3
    expect(after.error).toBe("stuck-timeout: worker heartbeat expired");

    // And the retry it was granted is still claimable (the requeue carries a
    // 60s backoff, so make it due first).
    await prisma.job.update({ where: { id: job.id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
    const parkedQueued = await parkQueuedAndPolling(job.id);
    let reclaimed: Awaited<ReturnType<typeof claimNextJob>> = null;
    try {
      reclaimed = await claimNextJob(`p37-reap-new-${stamp}`);
    } finally {
      await unpark(parkedQueued);
    }
    expect(reclaimed?.id).toBe(job.id);
  });

  // CONTROL — measured green against the pre-fix source too: the guard is not a
  // blanket refusal, a holder failing the attempt it actually holds still books
  // it.
  it("a LIVE holder still fails its own attempt (the guard is not a blanket refusal)", async () => {
    const user = await makeUser("live-fail");
    const job = await makeVideoJob(user.id, "live-fail");
    const W = `p37-live-${stamp}`;
    await prisma.job.update({ where: { id: job.id }, data: { status: "running", worker: W, attempts: 0 } });
    await failJob(job.id, "gateway reset the connection", { worker: W });
    const row = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(row.status).toBe("queued");
    expect(row.attempts).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2. Ops: the restore drill's guard, the rotation, the web gate
// ---------------------------------------------------------------------------
// The guard block and the rotation are extracted VERBATIM from the shipped
// scripts and executed, which is the only way a shell finding stays honest: a
// source-level assertion would keep passing while the arithmetic changed.
function extract(file: string, from: RegExp, to: RegExp): string {
  const src = read(file);
  const start = src.search(from);
  expect(start, `${file}: anchor not found ${from}`).toBeGreaterThan(-1);
  const rest = src.slice(start);
  const end = rest.search(to);
  expect(end, `${file}: end anchor not found ${to}`).toBeGreaterThan(-1);
  return rest.slice(0, end + rest.slice(end).split("\n")[0].length);
}

describe("pass 37 — the restore-drill guard and the retention rotation", () => {
  it("refuses a target that is not a bare bucket name (the trailing slash)", () => {
    // mc reads `alias/bucket/prefix`, so "pixelduo/" IS the live bucket to mc
    // and a different string to `[ = ]`: the drill mirrored --remove into the
    // live bucket, deleting every object uploaded since the snapshot, and
    // printed RESTORE DRILL PASSED (the restored count still matched).
    // Both halves of the refusal, verbatim: the bare-name case statement and
    // the live-name equality loop it protects.
    const guard = extract(
      "scripts/restore-objects.sh",
      /^case "\$SCRATCH_BUCKET" in/m,
      /^done$/m,
    );
    const run = (bucket: string) => {
      try {
        execFileSync(
          "bash",
          [
            "-c",
            `set -euo pipefail; SCRATCH_BUCKET="$1"; S3_BUCKET="live-bucket"; BACKUP_S3_BUCKET=""; BACKUP_TARGET_BUCKET=""; ${guard}; echo PASSED`,
            "_",
            bucket,
          ],
          { encoding: "utf8", stdio: "pipe" },
        );
        return "PASSED";
      } catch (e) {
        return `refused: ${String((e as { stderr?: string }).stderr ?? "").trim().split("\n")[0]}`;
      }
    };
    for (const bad of ["pixelduo/", "pixelduo//", "pixelduo/x", "s3://pixelduo", "", "a b"]) {
      expect(run(bad), `target '${bad}'`).toMatch(/^refused/);
    }
    // The pre-existing equality arm, unchanged: the pinned live name.
    expect(run("pixelduo")).toMatch(/^refused/);
    // A legitimate scratch bucket still passes.
    expect(run(`p37-drill-${stamp}`)).toBe("PASSED");
  });

  it("keeps the newest snapshot when the retention knob is 0", () => {
    // `tail -n +N` with N = KEEP + 1 = 1 prints EVERY line, so KEEP=0 deleted
    // the dump/snapshot renamed into place one line earlier and still printed a
    // success line: zero backups, every log affirming one.
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "p37-rot-"));
    const rotationFromCompose = (prettyFile: string) => {
      const src = read(prettyFile);
      const line = src
        .split("\n")
        .find((l) => l.includes("tail -n +$$((BACKUP_KEEP > 0 ? BACKUP_KEEP + 1 : 2))"));
      expect(line, `${prettyFile}: the clamped rotation line is missing`).toBeTruthy();
      // `$$` is the compose escape for a single `$`, and the fixture directory
      // replaces the container path (/backups) — the arithmetic under test is
      // everything after the glob, which is kept exactly as shipped.
      const body = line!.replace(/\$\$/g, "$").replace(/^ +/, "");
      return body.replace(/ls -1t .*?\| tail/, "ls -1t ./* | tail");
    };
    for (const file of ["docker-compose.yml", "docker-compose.single.yml"]) {
      const body = rotationFromCompose(file);
      for (const keep of [0, 1, 3]) {
        const d = path.join(dir, `${path.basename(file)}-${keep}`);
        fs.mkdirSync(d, { recursive: true });
        // Explicit mtimes, one day apart: `ls -1t` orders by mtime, and four
        // files written in the same tick can share one on a coarse-grained
        // filesystem — the runner's overlayfs made the order arbitrary and this
        // test failed there while passing on APFS, with the OLDEST file named
        // the newest. The date in the NAME and the timestamp on the file agree
        // here, so "the newest survives" is a deterministic claim.
        const at = (dayOfOct: number) => new Date(Date.UTC(2026, 9, dayOfOct, 0, 0, 0));
        for (const [i, s] of ["20261001-000000", "20261002-000000", "20261003-000000"].entries()) {
          const f = path.join(d, `pixelduo-${s}.dump.gz`);
          fs.writeFileSync(f, "x");
          fs.utimesSync(f, at(1 + i), at(1 + i));
        }
        // The newest file, as the loop writes it before rotating.
        const fresh = path.join(d, "pixelduo-20261014-000000.dump.gz");
        fs.writeFileSync(fresh, "x");
        fs.utimesSync(fresh, at(14), at(14));
        execFileSync("sh", ["-c", `set -e; BACKUP_KEEP=${keep}; cd ${JSON.stringify(d)}; ${body}`], {
          encoding: "utf8",
          stdio: "pipe",
        });
        const left = fs.readdirSync(d).sort();
        expect(left.length, `${file} with BACKUP_KEEP=${keep}`).toBe(Math.max(keep, 1));
        expect(left, "the newest dump must survive the rotation").toContain("pixelduo-20261014-000000.dump.gz");
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("clamps KEEP in both scripts, and refuses a non-numeric one", () => {
    for (const file of ["scripts/backup.sh", "scripts/backup-objects.sh"]) {
      const clamp = extract(file, /^case "\$KEEP" in/m, /^\[ "\$KEEP" -ge 1 \] \|\| KEEP=1$/m);
      const run = (keep: string) => {
        try {
          return execFileSync(
            "bash",
            ["-c", `set -euo pipefail; KEEP="$1"; ${clamp}; echo "KEEP=$KEEP"`, "_", keep],
            { encoding: "utf8", stdio: "pipe" },
          ).trim();
        } catch (e) {
          return String((e as { stderr?: string }).stderr ?? "").trim();
        }
      };
      expect(run("0"), file).toBe("KEEP=1");
      expect(run("14"), file).toBe("KEEP=14");
      expect(run("1O"), `${file}: a typo must fail loudly, not retune retention`).toMatch(
        /must be a non-negative integer/,
      );
    }
  });

  it("the web image gate asserts names the prune list actually removes", () => {
    // Pass 34 added `test ! -e /app/.env.example` to the WEB stage, where it is
    // unconditionally true: the web stage copies only .next/standalone,
    // .next/static, public/ and prisma/, and .env.example appears in ZERO trace
    // manifests (its own comment claimed it "can actually fail"). Pass 37
    // replaced it with names that are traced into standalone AND in the prune
    // list — so this test checks both halves: the assertion exists, and dropping
    // the name from the prune list is what the assertion would catch.
    const dockerfile = read("Dockerfile");
    const webStage = dockerfile.slice(dockerfile.indexOf("AS web"), dockerfile.indexOf("AS worker"));
    for (const name of [
      "instrumentation-client.ts",
      "sentry.server.config.ts",
      "sentry.edge.config.ts",
      "vitest.setup.ts",
    ]) {
      expect(webStage, `Dockerfile web prune must remove ${name}`).toMatch(
        new RegExp(`(^|\\s)${name.replace(/\./g, "\\.")}(\\s|$)`),
      );
      for (const file of [".github/workflows/ci.yml", "scripts/ci-local.sh"]) {
        expect(read(file), `${file} must assert ${name} absent`).toContain(`test ! -e /app/${name}`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 2b. Money: the fulfillment stamps its own instant on the DATABASE's clock
// ---------------------------------------------------------------------------
describe("pass 37 — paidAt and the check-in day key come from the database clock", () => {
  // Source-level because the property is a CLOCK, and a host and a database on
  // the same machine agree within milliseconds: a behavioural test would pass
  // against the pre-fix source here and only fail on a skewed deployment (the
  // same reason vitest.setup.ts refuses to run at all past 1000ms of skew).
  // `paidAt: new Date()` was the last app-clock write in fulfillOrder — a
  // skewed host stamped the payment before/after the CreditGrant rows the same
  // transaction created, so reconciling "paid at" against grant.createdAt
  // could read a grant that predates its own payment. checkinDateKey's default
  // argument was the other leftover: unused by production (dailyCheckin passes
  // dbNow) and exactly the footgun pass 35 fixed, so it is required now.
  it("no money timestamp is stamped from the app clock", () => {
    const ledger = read("lib/ledger.ts");
    expect(ledger).not.toMatch(/paidAt:\s*new Date\(\)/);
    expect(ledger).toMatch(/paidAt: fulfilledAt/);
    expect(ledger).toMatch(/const fulfilledAt = await dbNow\(client\)/);
    expect(ledger).not.toMatch(/checkinDateKey\(now = new Date\(\)\)/);
    expect(ledger).toMatch(/checkinDateKey\(now: Date\)/);
    expect(ledger).toMatch(/checkinDateKey\(await dbNow\(tx\)\)/);
  });
});

// ---------------------------------------------------------------------------
// 3. Ops: no transactional mail points at the vendor's domain
// ---------------------------------------------------------------------------
describe("pass 37 — mail links come from the deployment's own origin", () => {
  it("no mail body hard-codes a link to pixelduo.ai", () => {
    // Five of the seven bodies did (expiry, receipt, refund, 2FA-state and
    // password-changed) while the two auth mails already used NEXTAUTH_URL, so
    // a self-hosted instance mailed its own users to a site the operator does
    // not own — including the "if this wasn't you" notices.
    //
    // lib/login-guard.ts joined the list in pass 38: it builds the login-abuse
    // notice ("Repeated failed sign-in attempts…") and kept its own
    // `?? "https://pixelduo.ai"` fallback — the sixth body of the same class —
    // which this gate could not see while it read only the two files above.
    for (const file of ["lib/mail.ts", "lib/mail-html.ts", "lib/login-guard.ts"]) {
      const src = read(file);
      for (const line of src.split("\n")) {
        // EMAIL_FROM's default address and the prose comments may name the
        // domain; a URL must not.
        if (/^\s*(\/\/|\*|#)/.test(line)) continue;
        expect(line, `${file}: ${line.trim()}`).not.toMatch(/https?:\/\/pixelduo\.ai/);
      }
    }
  });

  it("the origin drives the links, and NFKC/ignorables cannot spell past the filter", async () => {
    const { expiryHtml } = await import("../lib/mail-html");
    expect(expiryHtml(2, 100, "https://pd.selfhosted.test")).toContain("https://pd.selfhosted.test/studio");
    expect(expiryHtml(2, 100, "https://pd.selfhosted.test")).not.toContain("pixelduo.ai");

    const { checkPrompt } = await import("../lib/safety");
    // NFKC folds (math alphanumerics, fullwidth) and the non-Cf ignorables
    // (CGJ U+034F, Hangul fillers U+1160/U+3164/U+FFA0) all rendered as
    // "nude" to a reader and walked `\bnude\b` pre-fix; the fold is applied
    // before the strip, so the U+1160 that NFKC emits from U+FFA0 is removed
    // in the same pass.
    for (const spelling of [
      "\u{1D427}\u{1D42E}\u{1D41D}\u{1D41E} woman", // 𝐧𝐮𝐝𝐞
      "\uFF4E\uFF55\uFF44\uFF45 woman", // ｎｕｄｅ
      "nud\u034Fe woman", // combining grapheme joiner
      "n\u3164ude woman", // Hangul filler
      "n\uFFA0ude woman", // halfwidth Hangul filler
      "n\u1160ude woman", // choseong filler
      "nud\u{E0065}e woman", // tag character
    ]) {
      expect(checkPrompt(spelling).ok, JSON.stringify(spelling)).toBe(false);
    }
    // Visible-width blanks stay (the NNBSP rule, unchanged): they are not
    // invisible, and no legitimate text depends on the stripped class.
    expect(checkPrompt("500\u202Fml bottle").ok).toBe(true);
    expect(checkPrompt("国风山水，晨雾中的远山").ok).toBe(true);
  });
});
