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

export function proxy(req: NextRequest) {
  // Last XFF entry = client IP appended by the trusted edge proxy; earlier
  // entries are client-spoofable (see lib/rate-limit.ts clientIp).
  const fwd = req.headers.get("x-forwarded-for");
  const parts = fwd?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
  const ip = parts[parts.length - 1] ?? req.headers.get("x-real-ip") ?? "unknown";
  const path = req.nextUrl.pathname;
  const isAuth = path.startsWith("/api/auth");
  // Auth is a coarse first line; per-account lockout (login-guard) is the
  // authoritative brute-force protection. 40/min leaves room for multi-step
  // 2FA logins (csrf + callback per step).
  // Overridable for load tests / e2e (MIDDLEWARE_AUTH_LIMIT).
  const authLimit = Number(process.env.MIDDLEWARE_AUTH_LIMIT ?? 40);
  const apiLimit = Number(process.env.MIDDLEWARE_API_LIMIT ?? 300);
  const retry = hit(`ip:${ip}:${isAuth ? "auth" : "api"}`, isAuth ? authLimit : apiLimit, 60_000);
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
