import { NextResponse, type NextRequest } from "next/server";
import { decode } from "next-auth/jwt";
import { envLimit } from "./lib/rate-limit";

// Edge-safe in-memory limiter: a cheap first line of defense, per-instance.
// Authoritative cross-instance limits live in route handlers backed by Redis
// (lib/rate-limit.ts, REDIS_URL) for generate/register/checkout/assistant.
const buckets = new Map<string, number[]>();

// Charge a request to one or more buckets; refuse if ANY of them is spent.
//
// A refused request charges NOTHING. That matters when a request carries two
// buckets (an auth path: the credential's and the source address's): if a spent
// credential still incremented the shared address bucket, its own exhaustion
// would become an instrument for exhausting the neighbour's budget — the
// denial-of-service direction pass 19 removed (an exhausted credential must
// simply be inert, not a hammer).
function hitAll(keys: string[], limit: number, windowMs: number): number | null {
  const now = Date.now();
  const windows = keys.map((k) => (buckets.get(k) ?? []).filter((t) => now - t < windowMs));
  let retry: number | null = null;
  for (const arr of windows) {
    if (arr.length >= limit) {
      retry = Math.max(retry ?? 0, Math.max(1, Math.ceil((arr[0] + windowMs - now) / 1000)));
    }
  }
  if (retry === null) for (const arr of windows) arr.push(now);
  keys.forEach((k, i) => buckets.set(k, windows[i]));
  sweep(now);
  return retry;
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
// account id AND the session's revocation version; everything else by source
// IP.
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
// traffic: a cookie the owner already revoked — by resetting the password or
// revoking sessions, the very remediation the product recommends — kept being
// charged to `u:<victim>:api`, 300/min from any address, and the refusal
// happens BEFORE any route runs. The owner's live browser shares that key, so
// their own workbench, gallery and 2FA login all answered 429 while the
// attacker kept spending. Separating the stale cookie from the live one restores
// the owner's budget.
//
// That separation used to be the hash of the raw cookie — and a cookie-keyed
// bucket is only as stable as the cookie, while the cookie is renewable for
// free: `/api/auth/session` re-encodes whatever token it decoded (next-auth
// v4's session route runs jwt.encode on every call), so one rotation request
// minted a fresh bucket. Pass 32 judged that bounded "for /api/*" because
// every authenticated route carries its own account-keyed Redis limiter — but
// the page shells have no route limiter (this layer is their ONLY ceiling) and
// a credential the guards REFUSE never reaches a route limiter either, so one
// rotation every 1.5s turned the page ceiling into 40×120/min per IP and left
// revoked/2FA-pending cookies costing a JWT decrypt plus a sessionVersion read
// with no account-keyed bound at all (probed).
//
// The fix is the key pass 31 could not use and did not need to invent: the
// token ALREADY carries the revocation version (`sv`, stamped by lib/auth.ts
// at mint time), and it is exactly what distinguishes a stale cookie from the
// live one — so keying on `u:<id>:<sv>` needs no database here, survives
// next-auth's re-encode (both claims are inside the payload and are preserved
// verbatim), and cannot be rotated away. Ownership of the live bucket is
// unchanged from pass 31: only a request holding a cookie that VERIFIES with
// the current sv can spend `u:<id>:<current sv>`.
//
// Keying by account is safe here because the id is only used when the JWT
// VERIFIES — an unverified cookie is attacker-chosen, and falls back to the
// address bucket — so this can only GIVE protection to requests that carry a
// real credential; it never takes it away from anonymous callers.
//
// What it does not fix: the pre-login routes run on the IP bucket, and they
// have to (there is no credential yet to key on), so a hostile egress can still
// deny the LOGIN flow — and the /api/auth/* reads a signed-in neighbour
// makes — for the whole IP. Bounding that would mean removing the limiter in
// front of password verification, which is the bcrypt-amplification brake — a
// worse trade. Residual, documented.
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
    if (typeof id !== "string" || !id) return `ip:${ip}`;
    // A token whose sv is not a number is one no current version mints; "na"
    // keeps it in a bucket of its own rather than the live session's.
    const sv = typeof payload?.sv === "number" ? String(payload.sv) : "na";
    return `u:${id}:${sv}`;
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
  const isApi = path.startsWith("/api");
  const isAuth = isApi && path.startsWith("/api/auth");
  // The authenticated SHELLS (pass 34). Until now the matcher covered /api/*
  // only, so these pages were the one place a request could do the full unit of
  // work — JWT decrypt, a sessionVersion read (plus role, for /admin), a React
  // SSR pass — with no bucket charged anywhere: an account capped at 300/min
  // through /api/* could drive /studio 400 times a minute (probed: 400×200,
  // zero 429s), and an anonymous caller's 307 flood was unbounded too. The
  // per-route account limiters in lib/api.ts are the binding ceiling for API
  // traffic; page routes are not route handlers, so nothing else can charge
  // them — this layer is the only one in front.
  const isPage =
    !isApi && (path.startsWith("/studio") || path.startsWith("/account") || path.startsWith("/admin"));
  // Auth is a coarse first line; per-account lockout (login-guard) is the
  // authoritative brute-force protection. 40/min leaves room for multi-step
  // 2FA logins (csrf + callback per step).
  // Overridable for load tests / e2e (MIDDLEWARE_AUTH_LIMIT).
  //
  // Note this bucket is per (account × `/api`), not per route: for a verified
  // session it is ONE 300/min budget shared by all 46 routes, so it — not the
  // 600/min a few routes document for themselves (/api/jobs, /api/files, the
  // v1 legs) — was the binding ceiling on a single instance. That is deliberate
  // (a cheaper backstop than 46 buckets, and tighter is the safe direction);
  // raise MIDDLEWARE_API_LIMIT if a real workload needs the headroom rather
  // than assuming a route's own number binds.
  //
  // Since pass 36 the credential half of that key is `u:<id>:<sv>` (see
  // bucketFor): stable across the free re-mints of /api/auth/session, and
  // split from a revoked cookie's bucket by the version itself — so for a
  // verified session this IS an account-keyed ceiling, the same one pass 31's
  // victim-denial objected to only because a STALE cookie could spend it. The
  // per-route account limiters in lib/api.ts remain the route-level ones; this
  // layer is the only one in front of the page shells. Auth paths take the
  // other trade — there the brake matters more than a neighbour's session
  // reads, so they carry the address key too.
  const authLimit = envLimit(process.env.MIDDLEWARE_AUTH_LIMIT, 40);
  const apiLimit = envLimit(process.env.MIDDLEWARE_API_LIMIT, 300);
  // Its own knob and its own bucket suffix, so an SSR page flood cannot spend
  // the API budget of the same session (and vice versa) — the page bucket is a
  // ceiling on work, not a toll on the account's own calls.
  const pageLimit = envLimit(process.env.MIDDLEWARE_PAGE_LIMIT, 120);
  const bucket = await bucketFor(req, ip);
  // Auth paths: the credential's own bucket AND the source address's (see the
  // rotation note above). The address key is the SAME one an anonymous caller
  // gets, so a cookie buys a second bucket to be measured against, never a
  // way off the shared one. Everywhere else: the credential's bucket alone —
  // an address key there would restore the CGNAT denial this file exists to
  // avoid, and the per-route account limiters are the binding ceiling anyway.
  // Pages take the same "credential's bucket alone" rule as /api/*.
  const keys =
    isAuth && !bucket.startsWith("ip:")
      ? [`${bucket}:auth`, `ip:${ip}:auth`]
      : [`${bucket}:${isAuth ? "auth" : isPage ? "page" : "api"}`];
  const retry = hitAll(keys, isAuth ? authLimit : isPage ? pageLimit : apiLimit, 60_000);
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
  // /api/* was the original matcher (the file's whole history is about API
  // buckets). The authenticated shells are listed too since pass 34 — they
  // render on every request and nothing else caps them; the matcher's own
  // _next/data arm covers the client-side navigations into them as well.
  matcher: ["/api/:path*", "/studio/:path*", "/account/:path*", "/admin/:path*"],
};
