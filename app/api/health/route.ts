import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getLimiterName } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// Public health check: DB reachability + service liveness.
export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({
      ok: true,
      service: "pixelduo",
      db: "up",
      rateLimiter: getLimiterName(),
      uptimeSec: Math.round(process.uptime()),
      time: new Date().toISOString(),
    });
  } catch {
    return NextResponse.json({ ok: false, db: "down" }, { status: 503 });
  }
}
