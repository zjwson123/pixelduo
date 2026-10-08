import { NextResponse, type NextRequest } from "next/server";
import { decode } from "next-auth/jwt";
import { envLimit } from "./lib/rate-limit";

// Edge-safe in-memory limiter: a cheap first line of defense, per-instance.
// Authoritative cross-instance limits live in route handlers backed by Redis
// (lib/rate-limit.ts, REDIS_URL) for generate/register/checkout/assistant.
const buckets = new Map<string, number[]>();

function hit(key: string, limit: number, windowMs: number): number | null {
  const now = Date.now();
  const arr = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (arr.length >= limit) {
    buckets.set(key, arr);
    sweep(now);
    return Math.max(1, Math.ceil((arr[0] + windowMs - now) / 1000));
  }
  arr.push(now);
  buckets.set(key, arr);
  sweep(now);
  return null;
}

// The map only shrinks on hit — an attacker spraying unique spoofed XFF
// entries (when deployed without the trusted edge proxy) would otherwise
// grow it without bound. Periodically drop empty/expired keys.
let lastSweep = 0;
function sweep(now: number) {
  if (now - lastSweep < 60_000 || buckets.size < 10_000) return;
  lastSweep = now;
  for (const [k, ts] of buckets) {
    if (!ts.length || now - ts[ts.length - 1] > 60_000) buckets.delete(k);
  }
}

// The bucket a request is charged to. A VERIFIED session is keyed by its
// account id AND the session's own cookie; everything else by source IP.
//
// The IP alone made this limiter a denial-of-service tool against itself: the
// bucket is spent before any credential is looked at, so a credential-less
// flood from a shared egress (CGNAT, a carrier NAT, an office or VPN egress)
// consumes the budget every authenticated user behind that IP needs — 40
// requests/minute to /api/auth/* locks the whole IP out of signing in, and 300
// to /api/* makes the workbench unusable — with no account, no cookie and no
// knowledge of the victims. That is the shape pass 18 fixed inside
// /api/auth/2fa-verify; this is the layer in front of all of it.
//
// The COOKIE half is pass 31's correction. Keying on the account id alone made
// one stale cookie a permanent, IP-independent denial of the owner's own
// traffic: this layer cannot see sessionVersion (it is a database concept; the
// token's signature is all it can check), so a cookie the owner already revoked
// — by resetting the password or revoking sessions, the very remediation the
// product recommends — kept being charged to `u:<victim>:api`, 300/min from any
// address, and the refusal happens BEFORE any route runs. The owner's live
// browser shares that key, so their own workbench, gallery and 2FA login all
// answered 429 while the attacker kept spending. And nothing ages the cookie
// out: /api/auth/session re-encodes the same token with a fresh 30-day expiry on
// every call. Hashing the raw cookie into the key bounds each cookie to its own
// budget: a flood still cannot dodge the throttle by rotating source addresses
// (the account id is all a stolen cookie can reach), but it can no longer spend
// the budget of a session it does not hold. The correct reading of the old
// comment: only an expired or forged token falls to the IP bucket — a revoked
// but signed one is charged to its own session.
//
// Keying by account is safe here because the id is only used when the JWT
// VERIFIES (an unverified cookie is attacker-chosen, so hashing it as given
// would hand out a fresh bucket per request), and the hash is of the VERIFIED
// cookie — so this can only GIVE protection to requests that carry a real one;
// it never takes it away from anonymous callers.
//
// What it does not fix: the pre-login routes still run on the IP bucket, and
// they have to (there is no credential yet to key on), so a hostile egress can
// still deny the LOGIN flow to its neighbours. Bounding that would mean
// removing the limiter in front of password verification, which is the
// bcrypt-amplification brake — a worse trade. Residual, documented.
async function sessionTag(raw: string): Promise<string> {
  // Web Crypto, not node:crypto: this module is the edge middleware. 8 bytes is
  // plenty — the tag only has to separate one cookie from another.
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  let tag = "";
  for (const b of new Uint8Array(digest).subarray(0, 8)) tag += b.toString(16).padStart(2, "0");
  return tag;
}

async function bucketFor(req: NextRequest, ip: string): Promise<string> {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) return `ip:${ip}`;
  // Both spellings: next-auth picks __Secure- purely from the NEXTAUTH_URL
  // scheme, and getting that wrong here would silently downgrade every
  // authenticated request back onto the shared IP bucket.
  const raw = ["__Secure-next-auth.session-token", "next-auth.session-token"]
    .map((n) => req.cookies.get(n)?.value)
    .find((v) => v);
  if (!raw) return `ip:${ip}`;
  try {
    // decode() is what next-auth itself uses to read the session cookie
    // (salt ""), and it returns null on a token that does not verify.
    const payload = await decode({ token: raw, secret });
    const id = payload?.uid ?? payload?.sub;
    return typeof id === "string" && id ? `u:${id}:${await sessionTag(raw)}` : `ip:${ip}`;
  } catch {
    return `ip:${ip}`;
  }
}

export async function proxy(req: NextRequest) {
  // Last XFF entry = client IP appended by the trusted edge proxy; earlier
  // entries are client-spoofable (see lib/rate-limit.ts clientIp).
  const fwd = req.headers.get("x-forwarded-for");
  const parts = fwd?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
  const ip =
    parts[parts.length - 1] ??
    (process.env.TRUST_X_REAL_IP === "1" ? req.headers.get("x-real-ip") : null) ??
    "unknown";
  const path = req.nextUrl.pathname;
  const isAuth = path.startsWith("/api/auth");
  // Auth is a coarse first line; per-account lockout (login-guard) is the
  // authoritative brute-force protection. 40/min leaves room for multi-step
  // 2FA logins (csrf + callback per step).
  // Overridable for load tests / e2e (MIDDLEWARE_AUTH_LIMIT).
  //
  // Note this bucket is per (account × `/api`), not per route: for a verified
  // session it is ONE 300/min budget shared by all 46 routes, so it — not the
  // 600/min a few routes document for themselves (/api/jobs, /api/files, the
  // v1 legs) — is the binding ceiling on a single instance. That is
  // deliberate (a cheaper backstop than 46 buckets, and tighter is the safe
  // direction); raise MIDDLEWARE_API_LIMIT if a real workload needs the
  // headroom rather than assuming a route's own number binds.
  const authLimit = envLimit(process.env.MIDDLEWARE_AUTH_LIMIT, 40);
  const apiLimit = envLimit(process.env.MIDDLEWARE_API_LIMIT, 300);
  const bucket = await bucketFor(req, ip);
  const retry = hit(`${bucket}:${isAuth ? "auth" : "api"}`, isAuth ? authLimit : apiLimit, 60_000);
  if (retry !== null) {
    return NextResponse.json(
      { ok: false, error: "rate-limited" },
      // Same no-store as lib/api.ts stamps on every other /api/* response: a
      // cache in front of /api/* would otherwise be free to pin one source's
      // rate-limit for a whole URL.
      { status: 429, headers: { "Retry-After": String(retry), "Cache-Control": "private, no-store" } },
    );
  }
  return NextResponse.next();
}

export const config = {
  matcher: "/api/:path*",
};
