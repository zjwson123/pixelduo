import NextAuth from "next-auth";
import { NextRequest } from "next/server";
import { authOptions } from "@/lib/auth";
import { ApiError, errorResponse, fail, enforceRateLimit, readBodyCapped, tooLarge, refuseNul } from "@/lib/api";
import { envLimit } from "@/lib/rate-limit";
import { authCallbackCookieName, authCallbackUrlAcceptable, secureAuthCookies } from "@/lib/auth-cookies";
import { siteBase } from "@/lib/site";

const handler = NextAuth(authOptions);

// The delegate, wrapped. next-auth reads its own body (getBody → req.json())
// and THAT parse was the one unguarded read left in the app: a malformed or
// empty JSON POST — no cookie, no CSRF token, the parse precedes both — threw
// a SyntaxError out of handler(), which is Next's uncaught path: a bare 500
// with no body and, on a deployment with SENTRY_DSN, one handled:false event
// per request (pass 38, probed live: /api/auth/session, signout, csrf and the
// credentials callback all answered 500 for `{`). Every app route answers 400
// invalid-json for the same input through fail(), and the middleware's
// 300/min per IP turned the difference into an anonymous incident faucet —
// the class pass 25 and pass 30 closed for NULs and lone surrogates, one
// layer up from where those guards run (they never see a body next-auth
// parses itself). This wrapper classifies ITS SyntaxError as the client error
// it is (the classification moved here in pass 70 — fail() no longer assumes
// every SyntaxError came from a request body), maps ApiError (the abort/NUL
// refusals) to their status, and still reports
// genuine faults.
async function delegate(req: NextRequest, ctx: Parameters<typeof handler>[1]) {
  try {
    return await handler(req, ctx);
  } catch (e) {
    // next-auth's own body parse (getBody → req.json()) is the one JSON.parse
    // outside parseJsonBody, so its SyntaxError is still the client error pass
    // 38 classified — but the classification now lives here, where the source
    // is known, instead of in fail() for every SyntaxError in the app (pass
    // 70; a route parsing a corrupted DB column must not answer invalid-json).
    if (e instanceof SyntaxError) {
      return errorResponse({ ok: false, error: "invalid-json" }, { status: 400 });
    }
    return fail(e);
  }
}

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
//
// The decision MUST be the same one next-auth makes. Its App Router adapter
// dispatches on `await context.params.nextauth` — the catch-all segments AFTER
// Next has decoded them (node_modules/next-auth/next/index.js) — while the raw
// request URL keeps percent-escapes (`new URL(req.url).pathname` is
// `/api/auth/%63allback/google`). Matching the pathname let an attacker spell
// the same callback a different way: next-auth minted the provider-verified
// account and this gate never charged the farming bucket (pass 54, probed live
// — `%63allback/credentials` reaches the same handler as the canonical path).
//
// The decoded array is therefore the primary input, and the regex stays only as
// a fallback for callers that supply no params. Extra trailing segments still
// charge this bucket (pass 33); only the provider segment decides the
// credentials exclusion, so `/api/auth/callback/credentials/…` stays out of it.
function isOAuthCallback(nextauth: string[] | undefined, pathname: string): boolean {
  if (nextauth && nextauth.length > 0) {
    return nextauth[0] === "callback" && nextauth[1] !== "credentials";
  }
  const m = /^\/api\/auth\/callback\/([^/]+)(?:\/.*)?$/.exec(pathname);
  return m !== null && m[1] !== "credentials";
}

// next-auth's credentials callback implements POST only; every other method
// falls to its `default` arm and answers `{status: 500, body: "Error: Callback
// for provider type credentials not supported"}` (pass 66). That is an
// anonymous, <img>-reachable 5xx reachable by a bare GET — no cookie, no CSRF
// token — so a page on any site could mint access-log/APM error rates for this
// deployment, and it breaks the app's own rule that malformed auth input is a
// 4xx (passes 38/50/64). Decoded segments first, for the same reason
// isOAuthCallback reads them: `%63allback/credentials` is the same route.
function isCredentialsCallback(nextauth: string[] | undefined, pathname: string): boolean {
  if (nextauth && nextauth.length > 0) {
    return nextauth[0] === "callback" && typeof nextauth[1] === "string" && nextauth[1].startsWith("credentials");
  }
  const m = /^\/api\/auth\/callback\/([^/]+)(?:\/.*)?$/.exec(pathname);
  return m !== null && m[1].startsWith("credentials");
}

// `context.params` is a Promise in Next 15+ and the tests pass one too; accept a
// plain object as well so a direct invocation cannot silently fall back to the
// raw-path regex for the wrong reason.
async function decodedNextAuth(ctx: Parameters<typeof handler>[1]): Promise<string[] | undefined> {
  const params = (
    ctx as unknown as { params?: { nextauth?: string[] } | Promise<{ nextauth?: string[] }> }
  ).params;
  if (!params) return undefined;
  return (await params)?.nextauth;
}

// next-auth's assertConfig validates a `callbackUrl` it cannot parse into a
// 500 — "There is a problem with the server configuration" — and it does so
// BEFORE the CSRF token, the session and any callback we define (pass 64).
// Pass 41 added a same-origin-only redirect callback, but assertConfig runs at
// a layer the callback cannot reach: its test exercised the callback directly
// and never the endpoint, so the anonymous 500 stayed live. A GET of
// `/api/auth/session?callbackUrl=foo` answered 500 from an <img> tag, one log
// line per request, and `javascript:`/`https://` (no host) behaved the same.
//
// The value comes from two places and they need different answers:
//   - the QUERY STRING is this request's input. A malformed one is client
//     garbage, so it is a 400 before next-auth looks at it. Every duplicate is
//     checked: next-auth reads the LAST one (`Object.fromEntries`), while
//     searchParams.get() returns the FIRST, so checking only the first would
//     leave `?callbackUrl=/studio&callbackUrl=foo` answering the 500 again.
//   - the COOKIE is state, not input. Refusing every auth request while it is
//     bad would lock the browser out of sign-in entirely, with no in-app way
//     to clear it — and the prefix does not protect the name: `__Host-`
//     forbids Domain but not PORT, so another service on this host can set it.
//     It is cleared here and the caller retries once.
function authCallbackUrlRefusal(req: NextRequest | Request) {
  const base = siteBase();
  // `new URL(req.url)`, not req.nextUrl: the wrapper is also invoked directly
  // (tests, scripts) with a plain Request, which has no nextUrl — that turned
  // the guard itself into a TypeError.
  // Empty is falsy in next-auth's own guard (`callbackUrlParam && …`), so it is
  // ignored rather than refused — mirror that instead of 400-ing a harmless
  // `?callbackUrl=`.
  const badQuery = new URL(req.url).searchParams
    .getAll("callbackUrl")
    .some((value) => value !== "" && !authCallbackUrlAcceptable(value, base));
  const cookieName = authCallbackCookieName();
  const badCookies = callbackCookieValues(req, cookieName).filter(
    (value) => value !== "" && !authCallbackUrlAcceptable(value, base),
  );
  if (!badQuery && badCookies.length === 0) return null;
  const refused = fail(
    new ApiError(
      400,
      badQuery
        ? "invalid-input: callbackUrl is not a valid URL"
        : "invalid-input: the sign-in callback cookie was invalid and has been cleared — retry the sign-in",
    ),
  );
  // The browser may have sent several copies of the name; one Set-Cookie with
  // an expired value clears the name for all of them.
  if (badCookies.length > 0) {
    refused.cookies.set(cookieName, "", {
      maxAge: 0,
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: secureAuthCookies(),
    });
  }
  return refused;
}

// The values of one cookie, matching what next-auth itself will read.
//
// A NextRequest parses the Cookie header for us (RequestCookies, the same
// `cookie` package next-auth's adapter uses). A plain Request — the tests call
// the exported handler directly — has no `.cookies`, so the header is parsed
// here; duplicates are kept (a browser may send several of one name and
// next-auth's Object.fromEntries keeps the last).
function callbackCookieValues(req: NextRequest | Request, name: string): string[] {
  const cookies = (req as NextRequest).cookies;
  if (cookies) {
    return cookies.getAll().filter((c) => c.name === name).map((c) => c.value);
  }
  const header = req.headers.get("cookie") ?? "";
  const values: string[] = [];
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0 || part.slice(0, eq).trim() !== name) continue;
    values.push(part.slice(eq + 1).trim());
  }
  return values;
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
  // and provisions (and credits) the account. The decoded segments also pass
  // the app's NUL/UTF-16 guard: this wrapper now awaits params before
  // next-auth does, and a `%00` in them reached the dependency's own lookups
  // (pass 27's rollout rule — a path param is guarded at the route).
  let nextauth: string[] | undefined;
  try {
    nextauth = await decodedNextAuth(ctx);
    for (const segment of nextauth ?? []) refuseNul(segment);
  } catch (e) {
    return fail(e);
  }
  // The credentials callback is POST-only; any other method is next-auth's
  // 500 fallback, so refuse it here as a 4xx with Allow (see
  // isCredentialsCallback). 405, not 400: the path is valid and the method is
  // the thing that is not.
  if (req.method !== "POST" && isCredentialsCallback(nextauth, new URL(req.url).pathname)) {
    return errorResponse(
      { ok: false, error: "method-not-allowed: the credentials callback is POST-only" },
      { status: 405, headers: { Allow: "POST" } },
    );
  }
  // Before delegation, because assertConfig would turn an unparsable value
  // into a 500 (see authCallbackUrlRefusal).
  const callbackRefusal = authCallbackUrlRefusal(req);
  if (callbackRefusal) return callbackRefusal;
  if (isOAuthCallback(nextauth, new URL(req.url).pathname)) {
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
  if (req.method !== "POST") return delegate(req, ctx);

  // readBodyCapped refuses a NUL body with ApiError and now classifies a
  // mid-body client disconnect as a 400 (lib/api.ts) — both read the body here
  // rather than inside the dependency, so both are mapped through fail(), the
  // same way every other route maps them.
  const bodyRaw = await readBodyCapped(req, MAX_BODY_BYTES, { allowNonJson: true }).catch((e: unknown) => ({
    refused: fail(e),
  }));
  if ("refused" in bodyRaw) return bodyRaw.refused;
  if ("tooLarge" in bodyRaw) return tooLarge();
  // The body has been consumed, so the handler gets a fresh request carrying the
  // same url/headers (next-auth reads nextUrl.searchParams, the cookie header and
  // the content type) plus the body as a string. content-length and
  // transfer-encoding are dropped because the re-encoded body has its own
  // length — a stale chunked marker or a mismatched length is rejected by the
  // Request constructor.
  const headers = new Headers(req.headers);
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  return delegate(
    new NextRequest(req.url, { method: req.method, headers, body: bodyRaw.raw }),
    ctx,
  );
}

export { limited as GET, limited as POST };
