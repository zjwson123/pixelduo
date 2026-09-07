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
    return NextResponse.json({
      ok,
      service: "pixelduo",
      db: dbOk ? "up" : "down",
      redis: !process.env.REDIS_URL ? "unconfigured" : redisOk ? "up" : "down",
      storage: storageOk ? "up" : "down",
      queue: { active: activeJob !== null },
      time: new Date().toISOString(),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, db: "down", error: "health-check-failed" }, { status: 503 });
  }
}
