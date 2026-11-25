// End-to-end smoke test against a RUNNING PixelDuo instance, exercising the
// REAL provider path (no MOCK_IMAGE_PROVIDER): register → login → generate →
// poll → download the delivered file → gallery/ledger/assistant.
//
//   npx tsx scripts/smoke-live.ts                 # http://localhost:3000
//   SMOKE_BASE_URL=https://pixelduo.ai npx tsx scripts/smoke-live.ts
//
// Costs real money: one gpt-image-2 image (~$0.02-0.04) plus one assistant call.
// That is the point — it is the only check that proves the outbound provider
// call, the queue, the storage write and the delivery are wired end to end. The
// mocked e2e suite (scripts/ci-local.sh) covers the same flow without billing.
//
// Writes the delivered image to SMOKE_OUT (default /tmp/pd-smoke.png) so the
// watermark/plan policy can be inspected by eye.
import fs from "fs";
import { randomBytes } from "node:crypto";

const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const OUT = process.env.SMOKE_OUT ?? "/tmp/pd-smoke.png";
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 240_000);

// Fixed default path, so a pre-planted symlink would make the script truncate
// whatever it points at. Owner-only, and O_NOFOLLOW refuses the symlink itself
// (pass 62 — the same class pass 61 closed in the shell scripts).
function writeOwnerOnly(path: string, data: Buffer): void {
  const fd = fs.openSync(
    path,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fs.writeFileSync(fd, data);
  } finally {
    fs.closeSync(fd);
  }
}

// Cookie jar: next-auth's session is a cookie, and every API route needs it.
const cookies = new Map<string, string>();
function saveCookies(res: Response) {
  const raw = res.headers.getSetCookie?.() ?? [];
  for (const line of raw) {
    const [pair] = line.split(";");
    const eq = pair.indexOf("=");
    if (eq > 0) cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}
const cookieHeader = () => [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), cookie: cookieHeader() },
    redirect: "manual",
  });
  saveCookies(res);
  return res;
}

function die(step: string, detail: string): never {
  console.error(`\n✗ ${step}: ${detail}`);
  process.exit(1);
}
function pass(step: string, detail = "") {
  console.log(`✓ ${step}${detail ? ` — ${detail}` : ""}`);
}

// Timestamps collide within the same second and the second register silently
// fails, which makes every ownership assertion meaningless (bit once before).
const email = `smoke-${Date.now()}-${process.hrtime.bigint() % 1000n}@smoke.test`;
// Random per run (pass 70). The script is documented to point at a REAL host
// (SMOKE_BASE_URL=https://…), and on a test deployment it leaves a verified
// 30-credit account behind whose password used to be a literal in this public
// repository: anyone who saw the printed address could sign in and spend. The
// account still exists after the run; its credential must not be guessable.
// 32 bytes → 43 URL-safe chars, well inside bcrypt's 72-byte limit.
const password = randomBytes(32).toString("base64url");

async function main() {
  console.log(`smoke against ${BASE}\n`);

  const health = await fetch(`${BASE}/api/health`).then((r) => r.json());
  if (!health.ok) die("health", JSON.stringify(health));
  pass("health", `db=${health.db} redis=${health.redis} storage=${health.storage}`);

  const reg = await call("/api/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, name: "Smoke" }),
  });
  const regBody = await reg.json();
  if (!regBody.ok) die("register", JSON.stringify(regBody));
  pass("register", regBody.pendingVerification ? "pending verification" : `userId=${regBody.userId}`);

  const csrf = await call("/api/auth/csrf").then((r) => r.json());
  const login = await call("/api/auth/callback/credentials", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrfToken: csrf.csrfToken, email, password, json: "true" }).toString(),
  });
  if (!login.ok) die("login", `${login.status} ${await login.text()}`);
  if (![...cookies.keys()].some((k) => k.includes("session-token"))) die("login", "no session cookie");
  pass("login", "session cookie set");

  const me = await call("/api/me").then((r) => r.json());
  if (!me.ok) die("me", JSON.stringify(me));
  if (me.user.credits < 1) die("me", `credits=${me.user.credits} — cannot generate`);
  pass("me", `credits=${me.user.credits} plan=${me.user.plan} verified=${Boolean(me.user.emailVerified)}`);

  // The generation itself: a real provider call (ModelVerse gpt-image-2 unless
  // the deployment points MODELVERSE_IMAGE_BASE_URL elsewhere).
  const prompt = `smoke test ${Date.now()}: a red paper lantern on a wooden table, soft daylight`;
  const gen = await call("/api/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt",
      prompt,
      quality: "medium",
      count: 1,
      idempotencyKey: `smoke-${Date.now()}`,
    }),
  });
  const genBody = await gen.json();
  if (!genBody.ok) die("generate", `${gen.status} ${JSON.stringify(genBody)}`);
  const jobId: string = genBody.jobId ?? genBody.job?.id;
  if (!jobId) die("generate", `no job id in ${JSON.stringify(genBody).slice(0, 200)}`);
  pass("generate", `job=${jobId} (queued)`);

  const started = Date.now();
  let job: Record<string, unknown> | null = null;
  while (Date.now() - started < TIMEOUT_MS) {
    const res = await call(`/api/jobs/${jobId}`).then((r) => r.json());
    job = res.job ?? res;
    const status = String((job as { status?: string })?.status ?? "");
    if (status === "done" || status === "failed") break;
    process.stdout.write(`\r  … ${status} (${Math.round((Date.now() - started) / 1000)}s)`);
    await new Promise((r) => setTimeout(r, 2500));
  }
  process.stdout.write("\r");
  const status = String((job as { status?: string })?.status ?? "");
  if (status !== "done") die("job", `status=${status} error=${(job as { error?: string })?.error ?? "-"}`);
  const images = ((job as { images?: unknown[] }).images ?? []) as unknown[];
  const urls = images
    .map((i) => (typeof i === "string" ? i : (i as { url?: string }).url))
    .filter((u): u is string => typeof u === "string");
  if (urls.length === 0) die("job", `done with no images: ${JSON.stringify(job).slice(0, 300)}`);
  pass("job", `done in ${Math.round((Date.now() - started) / 1000)}s — ${urls.length} artifact(s)`);

  // The delivered file has to be readable through /api/files with the session.
  const url = urls[0];
  const key = url.replace(/^.*\/api\/files\//, "").split("?")[0];
  const file = await call(`/api/files/${key}`);
  if (!file.ok) die("files", `${file.status} for ${key}`);
  const buf = Buffer.from(await file.arrayBuffer());
  const type = file.headers.get("content-type") ?? "";
  const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const isJpeg = buf[0] === 0xff && buf[1] === 0xd8;
  if (!isPng && !isJpeg) die("files", `not a raster image (${type}, ${buf.length}B)`);
  writeOwnerOnly(OUT, buf);
  pass("files", `${type} ${(buf.length / 1024).toFixed(0)}KB → ${OUT}`);

  const gallery = await call("/api/gallery").then((r) => r.json());
  const listed = (gallery.images ?? []).some((i: { url?: string }) => (i.url ?? "").includes(key));
  if (!listed) die("gallery", `new artifact not listed`);
  pass("gallery", `${(gallery.images ?? []).length} item(s), newest is ours`);

  const ledger = await call("/api/ledger").then((r) => r.json());
  const types = (ledger.entries ?? []).map((e: { type: string }) => e.type);
  if (!types.includes("PRE_AUTH") || !types.includes("SETTLE")) {
    die("ledger", `expected PRE_AUTH + SETTLE, got ${types.join(",")}`);
  }
  pass("ledger", types.slice(0, 4).join(" → "));

  // The prompt assistant is a second outbound provider path (DeepSeek).
  const assistant = await call("/api/assistant", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "a cat" }),
  }).then((r) => r.json());
  if (!assistant.ok) die("assistant", JSON.stringify(assistant).slice(0, 200));
  // `offline: true` means the LLM was never reached and the local expander
  // answered — a silently degraded path this check exists to catch (a half-set
  // DEEPSEEK_BASE_URL pair has exactly this symptom).
  if (assistant.offline) die("assistant", "answered from the OFFLINE expander — the provider was not reached");
  pass("assistant", `expanded to ${String(assistant.text ?? "").length} chars`);

  console.log(`\nSMOKE PASSED — ${email} (credits left: ${(await call("/api/me").then((r) => r.json())).user.credits})`);
}

main().catch((e) => die("unexpected", e instanceof Error ? e.message : String(e)));
