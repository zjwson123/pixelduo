import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { checkRedis } from "@/lib/rate-limit";
import { getStorage } from "@/lib/storage";
import { enforceRateLimit } from "@/lib/api";

export const dynamic = "force-dynamic";

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);
}

// The endpoint must stay unauthenticated (every compose file uses it as the
// container healthcheck), but each call costs a DB round-trip, a Redis ping,
// a Job query and a filesystem probe — cheap per request, a fine amplifier
// when an anonymous client can loop it. Cache the probe briefly and bound the
// request rate; a 5s TTL is far below any healthcheck interval.
const PROBE_TTL_MS = 5_000;
let cachedProbe: { at: number; body: Record<string, unknown>; ok: boolean } | null = null;
// One probe in flight at a time.
//
// The cache above is only populated when a probe FINISHES, so a burst that
// arrives before that — a container-start healthcheck storm, or anything
// inside the 60/min budget an anonymous caller is allowed — used to run one
// full probe PER REQUEST: a DB round-trip, a Redis ping, a Job query and a
// storage write+unlink each, from an endpoint that needs no credential. Those
// concurrent probes are also what made the storage driver's single probe file
// race, which is the other half of this fix (lib/storage.ts).
let inflightProbe: Promise<{ body: Record<string, unknown>; ok: boolean }> | null = null;

async function probe(): Promise<{ body: Record<string, unknown>; ok: boolean }> {
  const now = Date.now();
  if (cachedProbe && now - cachedProbe.at < PROBE_TTL_MS) {
    return { body: cachedProbe.body, ok: cachedProbe.ok };
  }
  if (!inflightProbe) {
    inflightProbe = runProbe(now).finally(() => {
      inflightProbe = null;
    });
  }
  return inflightProbe;
}

async function runProbe(now: number): Promise<{ body: Record<string, unknown>; ok: boolean }> {
  const [dbOk, redisOk, storageOk, activeJob] = await Promise.all([
    prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false),
    withTimeout(checkRedis(), 2500, false),
    withTimeout(getStorage().health(), 2500, false),
    withTimeout(
      prisma.job.findFirst({
        where: { status: { in: ["running", "polling"] } },
        select: { id: true },
      }),
      2500,
      null as { id: string } | null,
    ),
  ]);
  // REDIS_URL unset is a SUPPORTED mode, not a fault: the rate limiter falls
  // back to per-process memory (documented in .env.example and the README, and
  // relied on by lib/login-guard.ts and lib/twofa.ts, which preserve their caps
  // locally), and the body below already renders it as a third state —
  // "unconfigured", not "down". Counting it as a fault made a healthy no-Redis
  // instance answer 503 forever: the container healthcheck in all three compose
  // files is `wget -qO-` (the HTTP status IS the verdict), so the container was
  // marked unhealthy, `up --wait` aborted, and the documented `curl -fsS`
  // smoke gate failed while db and storage were green. "Configured but
  // unreachable" keeps the hard 503 — that is the real multi-instance outage
  // signal (see checkRedis), which is why this asks the env, not the probe.
  const ok = dbOk && storageOk && (redisOk || !process.env.REDIS_URL);
  // Public body: reachability + coarse queue liveness only. Queue depths and
  // heartbeat timestamps are recon food for timing submissions — not exposed.
  const body = {
    ok,
    service: "pixelduo",
    db: dbOk ? "up" : "down",
    redis: !process.env.REDIS_URL ? "unconfigured" : redisOk ? "up" : "down",
    storage: storageOk ? "up" : "down",
    queue: { active: activeJob !== null },
    time: new Date().toISOString(),
  };
  cachedProbe = { at: now, body, ok };
  return { body, ok };
}

// Public health check: DB / Redis / storage reachability + queue liveness.
export async function GET(req: Request) {
  try {
    const limited = await enforceRateLimit(req, "health", 60, 60_000);
    if (limited) return limited;
    const { body, ok: healthy } = await probe();
    // The status has to carry the verdict, because every consumer reads the
    // status and none of them parses the body: the container healthcheck in all
    // three compose files is `wget -qO-` (wget's exit code IS the HTTP status),
    // and scripts/ci-local.sh waits on `curl -fsS`. Answering 200 for
    // `{"ok":false}` therefore reported a database-down container as healthy
    // forever — precisely the state the check exists to surface — and the only
    // 503 this handler could produce was from its own exception path.
    return NextResponse.json(body, {
      status: healthy ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e) {
    return NextResponse.json({ ok: false, db: "down", error: "health-check-failed" }, { status: 503 });
  }
}
