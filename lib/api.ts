import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { z } from "zod";
import { authOptions } from "./auth";
import { prisma } from "./prisma";
import { rateLimit, clientIp } from "./rate-limit";
import { captureError } from "./observability";

// Clients surface the error string verbatim, so a bare "invalid-input" told
// the user nothing about which field failed (a 2-char prompt, an oversized
// upload, …). Summarize the first issue instead; the "invalid-input:" prefix
// keeps expectedStatus() mapping these to 400.
export function zodMessage(e: z.ZodError): Error {
  const issue = e.issues[0];
  if (!issue) return new Error("invalid-input");
  const field = issue.path.join(".") || "request body";
  if (issue.code === "too_small") return new Error(`invalid-input: ${field} must be at least ${issue.minimum}`);
  if (issue.code === "too_big") return new Error(`invalid-input: ${field} must be at most ${issue.maximum}`);
  if (issue.code === "invalid_type") return new Error(`invalid-input: ${field} must be ${issue.expected}`);
  return new Error(`invalid-input: ${field} is invalid`);
}

export async function sessionUser(): Promise<{ id: string; sv: number; totpPending: boolean }> {
  const session = await getServerSession(authOptions);
  const su = (session?.user as { id?: string; sv?: number; totpPending?: boolean } | undefined);
  if (!su?.id) throw new ApiError(401, "unauthorized");
  // A token without an `sv` claim cannot be revocation-checked. Defaulting it
  // to 0 accepted it for every account whose sessionVersion was still 0, so a
  // token minted before the claim existed (30-day lifetime, same secret across
  // a deploy) stayed valid, and any future credential-minting path that forgot
  // to stamp `sv` would be silently accepted instead of failing closed.
  if (typeof su.sv !== "number") throw new ApiError(401, "unauthorized");
  return { id: su.id, sv: su.sv, totpPending: su.totpPending ?? false };
}

// Partial (2FA-pending) session, still checked against the DB sessionVersion.
// The 2FA endpoints are the one credential-minting path that cannot go through
// requireUserId (it rejects totpPending sessions by design), so they must do
// the revocation check themselves — otherwise a stolen password-only session
// keeps working after the owner resets their password or revokes sessions, and
// retains a live TOTP/backup-code oracle.
export async function requirePartialSession(): Promise<{ id: string; totpPending: boolean }> {
  const { id, sv, totpPending } = await sessionUser();
  const user = await prisma.user.findUnique({ where: { id }, select: { sessionVersion: true } });
  if (!user || user.sessionVersion !== sv) throw new ApiError(401, "unauthorized");
  return { id, totpPending };
}

export async function requireUserId(): Promise<string> {
  const { id, sv, totpPending } = await sessionUser();
  // Partial 2FA sessions must not touch protected resources.
  if (totpPending) throw new ApiError(403, "2fa-required");
  // Session revocation: password reset / revoke-all bumps User.sessionVersion;
  // older JWTs carry a stale version and are rejected here.
  const user = await prisma.user.findUnique({ where: { id }, select: { sessionVersion: true } });
  if (!user || user.sessionVersion !== sv) throw new ApiError(401, "unauthorized");
  return id;
}

// Account gate for credit-consuming actions: email must be verified first
// (anti-abuse — unverified accounts can't burn provider cost).
export async function requireVerifiedUser(): Promise<string> {
  return (await requireVerifiedUserSession()).id;
}

// Same gate, but it also hands back the session version the request was
// authorized with. Credential-minting paths need it (ApiKey.sessionVersion):
// the DB is re-read inside the transaction that writes the credential, because
// the version checked here at the top of the request can be revoked while the
// transaction is in flight, and a credential stamped with a superseded version
// authenticates as nothing.
export async function requireVerifiedUserSession(): Promise<{ id: string; sv: number }> {
  const { id, sv, totpPending } = await sessionUser();
  if (totpPending) throw new ApiError(403, "2fa-required");
  const user = await prisma.user.findUnique({ where: { id }, select: { emailVerified: true, sessionVersion: true } });
  if (!user || user.sessionVersion !== sv) throw new ApiError(401, "unauthorized");
  if (!user.emailVerified) throw new ApiError(403, "verify-email-required");
  return { id, sv };
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    /** Seconds a 429 tells the client to wait, when the limiter reported one. */
    public retryAfterSec?: number,
  ) {
    super(message);
  }
}

export function ok(data: unknown, init?: ResponseInit) {
  // Every ok() response is either user-scoped or freshly computed; none is
  // URL-addressable public content. Nothing caches them today (Caddy is a
  // plain reverse proxy and these carry no Last-Modified), but a future CDN or
  // a proxy caching /api/* would key on URL alone and serve one user's
  // /api/me, gallery or order history to another. Opt out explicitly.
  const headers = new Headers(init?.headers);
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", "private, no-store");
  return NextResponse.json({ ok: true, ...(data as object) }, { ...init, headers });
}

// HTTP status for an expected business error, classified from its message.
// Returns null for unexpected errors — those are masked as a generic 500.
//
// Every test here is an exact match or an anchored prefix, never a substring.
// The previous version classified with `msg.includes("already")`,
// `includes("not-found")` and `includes("insufficient")`, so any UNEXPECTED
// internal error whose text merely contained one of those words was echoed to
// the API client verbatim as a 4xx AND skipped the captureError below — the
// caller got raw internals, and the incident never reached the logs or Sentry.
// Prisma's transaction manager produces exactly such messages ("Transaction
// already closed: A query cannot be executed on a transaction that was rolled
// back."), i.e. a broken transaction was reported to the user as a 409 and
// never recorded.
const NOT_FOUND_MESSAGES = new Set([
  "user-not-found",
  "order-not-found",
  "item-not-found",
  "job-not-found",
  "image-not-found",
]);

function expectedStatus(msg: string): number | null {
  if (
    msg.startsWith("invalid-") ||
    msg.startsWith("blocked:") ||
    msg.startsWith("blocked-") ||
    msg.startsWith("unknown-model:") ||
    msg.startsWith("model-disabled:") ||
    msg.startsWith("not-a-video-model:") ||
    msg.startsWith("video-timeout:") ||
    msg.startsWith("image-flagged:") ||
    msg.startsWith("cannot-") ||
    msg === "2fa-code-required" ||
    msg === "2fa-not-enabled" ||
    msg === "insufficient-credits"
  ) {
    return 400;
  }
  if (msg.startsWith("too-many-keys") || msg === "email-already-registered") return 409;
  // "2fa-locked" is the cumulative second-factor brake (lib/twofa.ts), not the
  // per-minute burst limiter: the account is refused for the rest of a 24h
  // window, so it is a distinct message the client can tell apart from
  // "rate-limited" — and it is a 429 (retryable, not an incident), never a 500.
  if (msg.startsWith("queue-full:") || msg === "rate-limited" || msg === "2fa-locked") return 429;
  if (msg === "unauthorized") return 401;
  if (msg === "2fa-required" || msg === "admin-required" || msg === "verify-email-required") {
    return 403;
  }
  if (msg === "invalid-password" || msg === "invalid-code") return 400;
  if (NOT_FOUND_MESSAGES.has(msg)) return 404;
  return null;
}

// Error responses carry no-store for the same reason ok() does: a 404/400 for
// a URL-addressable resource is heuristically cacheable, so a shared cache in
// front of /api/* could pin one user's error for every other visitor to that
// path. Kept in one place so every error path inherits it. Exported for the
// routes that need their own status/headers (the /api/v1 family's 429s carry
// Retry-After and RateLimit-*): a hand-rolled NextResponse missed both this
// header and the JSON content type.
export function errorResponse(body: Record<string, unknown>, init: ResponseInit) {
  const headers = new Headers(init.headers);
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", "private, no-store");
  return NextResponse.json(body, { ...init, headers });
}

export function fail(error: unknown) {
  if (error instanceof ApiError) {
    // A 429 that carries no Retry-After is one a client can only guess at, and
    // the IP-keyed limiter (enforceRateLimit) has always sent one: an
    // authenticated route that hit its ACCOUNT bucket answered the same status
    // with none, so the same route returned two different shapes for the same
    // condition and every honouring client lost its backoff hint.
    const headers: Record<string, string> = {};
    if (error.status === 429 && error.retryAfterSec) headers["Retry-After"] = String(error.retryAfterSec);
    return errorResponse({ ok: false, error: error.message }, { status: error.status, headers });
  }
  // A malformed JSON body is a client error, not an incident.
  if (error instanceof SyntaxError) {
    return errorResponse({ ok: false, error: "invalid-json" }, { status: 400 });
  }
  const msg = error instanceof Error ? error.message : "internal-error";
  // Expected business errors are not incidents; capture only unexpected 500s.
  const status = expectedStatus(msg);
  if (status === null) {
    captureError(error, { error: msg });
    // Do not leak internal error details to API clients.
    return errorResponse({ ok: false, error: "internal-error" }, { status: 500 });
  }
  return errorResponse({ ok: false, error: msg }, { status });
}

// Route-level limit keyed by IP + scope. Returns 429 response when exceeded.
//
// For routes that have not identified the caller yet (register, the auth-mail
// pair, health, the payment webhook, the signed-out feedback form). An
// authenticated route must use enforceUserRateLimit instead: see the note there
// for why a shared source-address bucket turns one stranger's traffic into
// everyone else's outage.
export async function enforceRateLimit(
  req: Request,
  scope: string,
  limit: number,
  windowMs: number,
): Promise<NextResponse | null> {
  const r = await rateLimit(`${scope}:${clientIp(req)}`, limit, windowMs);
  if (!r.ok) {
    return errorResponse(
      { ok: false, error: "rate-limited" },
      {
        status: 429,
        headers: {
          "Retry-After": String(r.retryAfterSec),
          "RateLimit-Limit": String(limit),
          "RateLimit-Remaining": String(r.remaining ?? 0),
        },
      },
    );
  }
  return null;
}

// The budget for an AUTHENTICATED route, keyed on the account — the only leg
// these routes carry.
//
// It is deliberately not paired with the per-IP bucket: everyone behind one
// egress (an office, a VPN, a carrier NAT) shares that bucket, and it is spent
// BEFORE any credit is checked, so a single verified account with an empty
// balance could hold it full with requests answered "insufficient-credits" —
// refusing generation, checkout and Explore to unrelated neighbours, at no cost
// to itself. The account is the dimension that can be held responsible for the
// traffic; a source address shared by strangers cannot. The middleware already
// took this decision for authenticated traffic (proxy.ts bucketFor). The
// residual — many accounts flooding from one address — is bounded by
// registration (mailbox verification + REGISTER_RATE_LIMIT), which is the same
// residual and the same bound the middleware documents.
//
// Still second to `loginFailures`/the 2FA brake where a guess is being counted:
// those bounds must not be dilutable across IPs, which is why they are keyed
// this way too.
export async function enforceUserRateLimit(
  userId: string,
  scope: string,
  limit: number,
  windowMs: number,
): Promise<ApiError | null> {
  const r = await rateLimit(`u:${scope}:${userId}`, limit, windowMs);
  return r.ok ? null : new ApiError(429, "rate-limited", r.retryAfterSec);
}

// Upper bound for ?page=. Clamping only the lower bound left a huge finite
// value (21+ digits) producing a skip of ~1e21 — a non-integer the query
// engine rejects, i.e. a masked 500 instead of the "garbage input degrades to
// page 1" the guards promise. Far past any real result set.
export const PAGE_MAX = 10_000;
export function clampPage(raw: string | null, max = PAGE_MAX): number {
  const n = Number.parseInt(raw ?? "1", 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, max);
}

// Refuse oversized bodies BEFORE req.json() buffers them: Node route handlers
// have no built-in cap, so a multi-hundred-MB authenticated upload is a heap-
// exhaustion vector even when zod would reject it after parsing. Streams the
// body with a running byte counter and aborts at the cap — req.text() would
// buffer the ENTIRE body first (chunked transfer-encoding sends no
// content-length, so the header pre-check alone is bypassable). Counts bytes,
// not string length, so multibyte bodies can't slip ~3-4x past the cap.
// Returns the raw string — callers JSON.parse it themselves.
//
// U+0000 is refused here, once, for every JSON route. No schema rejected it and
// nothing stripped it, but PostgreSQL's text type does: the write died with
// SQLSTATE 22021, which is an UNEXPECTED error, so fail() masked it as
// internal-error (500) and captureError() reported an incident — and this
// helper is on unauthenticated routes (feedback, register, forgot-password), so
// anyone could burn the error quota and bury real incidents with one request
// per NUL. Throwing ApiError means fail() answers 400 with the reason, which is
// what the caller sent: garbage input must not read as a server fault.
export async function readBodyCapped(
  req: Request,
  maxBytes: number,
): Promise<{ tooLarge: true } | { raw: string }> {
  const declared = Number(req.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { tooLarge: true };
  }
  if (!req.body) {
    const raw = await req.text();
    if (Buffer.byteLength(raw, "utf8") > maxBytes) return { tooLarge: true };
    refuseNul(raw);
    return { raw };
  }
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      // Cancel so the client upload is cut off instead of drained.
      await reader.cancel().catch(() => {});
      return { tooLarge: true };
    }
    chunks.push(value);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  refuseNul(raw);
  return { raw };
}

// Every JSON request body is parsed through here, so the NUL refusal is one
// guard rather than one per route (and one per field). The raw-body check
// above cannot see a NUL that arrived as an ESCAPE: `{"message":"a\u0000b"}`
// is seven ASCII characters on the wire and a real U+0000 after JSON.parse, and
// that is how the live probe hit SQLSTATE 22021 on /api/feedback. The walk runs
// after parsing, so no encoding of the character survives it.
export function parseJsonBody(raw: string): unknown {
  const value: unknown = JSON.parse(raw);
  refuseNulDeep(value, 0);
  return value;
}

function refuseNulDeep(value: unknown, depth: number): void {
  if (depth > 32) return; // Bounded like the body cap: no recursion bombs.
  if (typeof value === "string") {
    refuseNul(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) refuseNulDeep(item, depth + 1);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) {
      refuseNulDeep(item, depth + 1);
    }
  }
}

// Shared by the body reader above and by query-parameter readers: a NUL cannot
// reach PostgreSQL from either. Kept as a throwing helper rather than a
// sanitizer — silently deleting bytes out of a prompt or a report would change
// what the user wrote, and this codebase's rule is that a refusal is honest and
// a silent substitution is not.
export function refuseNul(value: string): void {
  if (value.includes("\u0000")) {
    throw new ApiError(400, "invalid-input: NUL characters are not allowed");
  }
}

// Free-text query parameter, bounded: `?cat=`/`?q=` feed unindexed `contains`
// scans (only the cost matters), and a NUL in one was the third way into the
// 22021-masked-500 above — `?cat=%00` on /api/templates produced two Postgres
// errors and two captured incidents per request, for anyone with an account.
export function queryText(raw: string | null, max: number): string | null {
  if (raw === null) return null;
  refuseNul(raw);
  return raw.slice(0, max);
}
