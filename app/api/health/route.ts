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

async function probe(): Promise<{ body: Record<string, unknown>; ok: boolean }> {
  const now = Date.now();
  if (cachedProbe && now - cachedProbe.at < PROBE_TTL_MS) {
    return { body: cachedProbe.body, ok: cachedProbe.ok };
  }
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
  const ok = dbOk && redisOk && storageOk;
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
    const { body } = await probe();
    return NextResponse.json(body, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e) {
    return NextResponse.json({ ok: false, db: "down", error: "health-check-failed" }, { status: 503 });
  }
}
