import NextAuth from "next-auth";
import { NextRequest } from "next/server";
import { authOptions } from "@/lib/auth";
import { enforceRateLimit, readBodyCapped } from "@/lib/api";
import { envLimit } from "@/lib/rate-limit";

const handler = NextAuth(authOptions);

// Legitimate bodies here are a CSRF token plus an email and password, or an
// OAuth callback's form fields — a few hundred bytes. 64KB is pure headroom.
const MAX_BODY_BYTES = 64 * 1024;

// OAuth callbacks MINT accounts: with GOOGLE_CLIENT_ID/GITHUB_CLIENT_ID set,
// three or four requests to /api/auth/callback/<provider> produce a
// provider-verified address that ensureOAuthUser turns into a local account and
// releases the 30-credit signup bonus for — each account mapping 1:1 onto real
// provider cost. The password path caps creation per source address
// (REGISTER_RATE_LIMIT, 10/hour); OAuth had only the coarse 300/min below, i.e.
// ~300 spendable credits a minute from one address.
//
// This check cannot live in the signIn callback, which is where the account is
// actually created: next-auth 4.24 calls it with {user, account, profile} only
// (core/routes/callback.js), so there is no request and no client address to
// key on. Hence the cap sits here, where the request is, and covers GET as well
// as POST — the provider's own redirect back to us is a GET, so a POST-only cap
// would leave the account-minting path unthrottled.
//
// 30/hour is 3x the register cap because this bucket also counts ordinary
// sign-ins: a person behind a shared NAT address may sign in repeatedly, and no
// human reaches 30 in an hour. It cuts farming from ~600 accounts/hour (what
// the coarse limiter allows at ~10/min) to at most 30/hour/IP — 900 credits an
// hour instead of 18,000. Env-tunable like REGISTER_RATE_LIMIT, and the cap
// cannot be disabled by a typo or a missing variable: envLimit falls back to
// the default on anything that is not a positive number, and a Redis outage
// degrades this to the per-instance in-memory limiter (lib/rate-limit.ts)
// rather than to no check.
const OAUTH_CALLBACK_RATE_LIMIT_DEFAULT = 30;

// /api/auth/callback/<provider>. The credentials provider is excluded: that POST
// is the password login, already bounded per account by lib/login-guard.ts, and
// capping it here would spend an account-creation budget on ordinary logins.
function isOAuthCallback(pathname: string): boolean {
  const m = /^\/api\/auth\/callback\/([^/]+)$/.exec(pathname);
  return m !== null && m[1] !== "credentials";
}

// Per-IP cap on ALL NextAuth endpoints (credentials login, CSRF/session
// fetches, OAuth hops). The per-account lockout (lib/login-guard.ts) stops
// targeted brute force, but without this one IP can password-spray thousands
// of distinct emails forever — each attempt also burns a bcrypt compare, a
// cheap CPU-DoS amplification. 300/min is high enough for shared-NAT offices
// and the e2e suite, low enough to bound the bcrypt burn.
//
// This wrapper is also the ONLY body cap on the auth endpoints. next-auth's own
// route handler reads the body itself (getBody → req.json()/req.text()) and does
// so BEFORE it looks at the CSRF token, so a cookie-less, token-less request was
// buffered in full — it was the last body-reading endpoint in the app without a
// cap, and the only unauthenticated one. Request.json() holds the byte buffer
// and the decoded string at once, so a single ~500MB chunked POST (no
// content-length to pre-check, no rate limit that counts bytes) ends the
// container for every user, not just this route. readBodyCapped cannot be
// called from inside the dependency, so the body is drained here under a byte
// cap and the handler is handed a request carrying the (already bounded) body.
async function limited(req: NextRequest, ctx: Parameters<typeof handler>[1]) {
  const res = await enforceRateLimit(req, "auth-endpoint", 300, 60_000);
  if (res) return res;
  // Account-farming cap, before the handler below exchanges the provider code
  // and provisions (and credits) the account.
  if (isOAuthCallback(new URL(req.url).pathname)) {
    const oauth = await enforceRateLimit(
      req,
      "oauth-callback",
      envLimit(process.env.OAUTH_CALLBACK_RATE_LIMIT, OAUTH_CALLBACK_RATE_LIMIT_DEFAULT),
      3_600_000,
    );
    if (oauth) return oauth;
  }
  // GET (session/CSRF/providers/OAuth redirect) carries no body and next-auth
  // reads none — delegate as-is.
  if (req.method !== "POST") return handler(req, ctx);

  const bodyRaw = await readBodyCapped(req, MAX_BODY_BYTES);
  if ("tooLarge" in bodyRaw) return new Response("payload too large", { status: 413 });
  // The body has been consumed, so the handler gets a fresh request carrying the
  // same url/headers (next-auth reads nextUrl.searchParams, the cookie header and
  // the content type) plus the body as a string. content-length and
  // transfer-encoding are dropped because the re-encoded body has its own
  // length — a stale chunked marker or a mismatched length is rejected by the
  // Request constructor.
  const headers = new Headers(req.headers);
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  return handler(
    new NextRequest(req.url, { method: req.method, headers, body: bodyRaw.raw }),
    ctx,
  );
}

export { limited as GET, limited as POST };
