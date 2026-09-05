import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { checkRedis } from "@/lib/rate-limit";
import { getStorage } from "@/lib/storage";

export const dynamic = "force-dynamic";

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);
}

// Public health check: DB / Redis / storage reachability + queue liveness.
export async function GET() {
  try {
    const [dbOk, redisOk, storageOk, queue] = await Promise.all([
      prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false),
      withTimeout(checkRedis(), 2500, false),
      withTimeout(getStorage().health(), 2500, false),
      withTimeout(
        prisma.$transaction([
          prisma.job.count({ where: { status: "queued" } }),
          prisma.job.count({ where: { status: "running" } }),
          prisma.job.findFirst({
            where: { status: "running" },
            orderBy: { heartbeatAt: "desc" },
            select: { heartbeatAt: true },
          }),
        ]),
        2500,
        [0, 0, null] as [number, number, { heartbeatAt: Date | null } | null],
      ),
    ]);
    const ok = dbOk && redisOk && storageOk;
    // Public body: reachability + queue liveness only. Backend internals
    // (limiter implementation, uptime) are deliberately not exposed.
    return NextResponse.json({
      ok,
      service: "pixelduo",
      db: dbOk ? "up" : "down",
      redis: !process.env.REDIS_URL ? "unconfigured" : redisOk ? "up" : "down",
      storage: storageOk ? "up" : "down",
      queue: {
        queued: queue[0],
        running: queue[1],
        lastHeartbeat: queue[2]?.heartbeatAt ?? null,
      },
      time: new Date().toISOString(),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, db: "down", error: "health-check-failed" }, { status: 503 });
  }
}
