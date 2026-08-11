import { NextResponse, type NextRequest } from "next/server";

// Edge-safe in-memory limiter: a cheap first line of defense, per-instance.
// Authoritative cross-instance limits live in route handlers backed by Redis
// (lib/rate-limit.ts, REDIS_URL) for generate/register/checkout/assistant.
const buckets = new Map<string, number[]>();

function hit(key: string, limit: number, windowMs: number): number | null {
  const now = Date.now();
  const arr = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (arr.length >= limit) {
    buckets.set(key, arr);
    return Math.max(1, Math.ceil((arr[0] + windowMs - now) / 1000));
  }
  arr.push(now);
  buckets.set(key, arr);
  return null;
}

export function middleware(req: NextRequest) {
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    "unknown";
  const path = req.nextUrl.pathname;
  const isAuth = path.startsWith("/api/auth");
  const retry = hit(`ip:${ip}:${isAuth ? "auth" : "api"}`, isAuth ? 20 : 300, 60_000);
  if (retry !== null) {
    return NextResponse.json(
      { ok: false, error: "rate-limited" },
      { status: 429, headers: { "Retry-After": String(retry) } },
    );
  }
  return NextResponse.next();
}

export const config = {
  matcher: "/api/:path*",
};
