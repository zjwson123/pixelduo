import NextAuth from "next-auth";
import { NextRequest } from "next/server";
import { authOptions } from "@/lib/auth";
import { enforceRateLimit, readBodyCapped } from "@/lib/api";

const handler = NextAuth(authOptions);

// Legitimate bodies here are a CSRF token plus an email and password, or an
// OAuth callback's form fields — a few hundred bytes. 64KB is pure headroom.
const MAX_BODY_BYTES = 64 * 1024;

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
