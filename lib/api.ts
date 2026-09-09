import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "./auth";
import { prisma } from "./prisma";
import { rateLimit, clientIp } from "./rate-limit";
import { captureError } from "./observability";

export async function sessionUser(): Promise<{ id: string; sv: number; totpPending: boolean }> {
  const session = await getServerSession(authOptions);
  const su = (session?.user as { id?: string; sv?: number; totpPending?: boolean } | undefined);
  if (!su?.id) throw new ApiError(401, "unauthorized");
  return { id: su.id, sv: su.sv ?? 0, totpPending: su.totpPending ?? false };
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
  const { id, sv, totpPending } = await sessionUser();
  const userId = id;
  if (totpPending) throw new ApiError(403, "2fa-required");
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { emailVerified: true, sessionVersion: true } });
  if (!user || user.sessionVersion !== sv) throw new ApiError(401, "unauthorized");
  if (!user.emailVerified) throw new ApiError(403, "verify-email-required");
  return userId;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export function ok(data: unknown, init?: ResponseInit) {
  return NextResponse.json({ ok: true, ...(data as object) }, init);
}

// HTTP status for an expected business error, classified from its message.
// Returns null for unexpected errors — those are masked as a generic 500.
function expectedStatus(msg: string): number | null {
  if (
    msg.startsWith("invalid-") ||
    msg.startsWith("blocked:") ||
    msg.startsWith("unknown-model:") ||
    msg.startsWith("model-disabled:") ||
    msg.startsWith("not-a-video-model:") ||
    msg.startsWith("video-timeout:") ||
    msg.startsWith("image-flagged:")
  ) {
    return 400;
  }
  if (msg.startsWith("queue-full:") || msg.includes("rate-limited")) return 429;
  if (msg.includes("unauthorized")) return 401;
  if (msg.includes("2fa-required") || msg.includes("admin-required") || msg.includes("verify-email-required")) {
    return 403;
  }
  if (msg.includes("2fa-not-enabled") || msg.includes("invalid-password") || msg.includes("invalid-code")) return 400;
  if (msg.includes("not-found")) return 404;
  if (msg.includes("already")) return 409;
  if (msg.includes("insufficient")) return 400;
  return null;
}

export function fail(error: unknown) {
  if (error instanceof ApiError) {
    return NextResponse.json({ ok: false, error: error.message }, { status: error.status });
  }
  // A malformed JSON body is a client error, not an incident.
  if (error instanceof SyntaxError) {
    return NextResponse.json({ ok: false, error: "invalid-json" }, { status: 400 });
  }
  const msg = error instanceof Error ? error.message : "internal-error";
  // Expected business errors are not incidents; capture only unexpected 500s.
  const status = expectedStatus(msg);
  if (status === null) {
    captureError(error, { error: msg });
    // Do not leak internal error details to API clients.
    return NextResponse.json({ ok: false, error: "internal-error" }, { status: 500 });
  }
  return NextResponse.json({ ok: false, error: msg }, { status });
}

// Route-level limit keyed by IP + scope. Returns 429 response when exceeded.
export async function enforceRateLimit(
  req: Request,
  scope: string,
  limit: number,
  windowMs: number,
): Promise<NextResponse | null> {
  const r = await rateLimit(`${scope}:${clientIp(req)}`, limit, windowMs);
  if (!r.ok) {
    return NextResponse.json(
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

// Per-account limit complementing the per-IP one: an attacker distributing
// TOTP guesses across IPs must not dilute the limit for a single account.
export async function enforceUserRateLimit(
  userId: string,
  scope: string,
  limit: number,
  windowMs: number,
): Promise<ApiError | null> {
  const r = await rateLimit(`u:${scope}:${userId}`, limit, windowMs);
  return r.ok ? null : new ApiError(429, "rate-limited");
}

// Refuse oversized bodies BEFORE req.json() buffers them: Node route handlers
// have no built-in cap, so a multi-hundred-MB authenticated upload is a heap-
// exhaustion vector even when zod would reject it after parsing. Reads the
// body once (text() consumes it) and hands the raw string back — callers
// JSON.parse it themselves. Same pattern as the payment webhook route.
export async function readBodyCapped(
  req: Request,
  maxBytes: number,
): Promise<{ tooLarge: true } | { raw: string }> {
  const declared = Number(req.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { tooLarge: true };
  }
  const raw = await req.text();
  if (raw.length > maxBytes) {
    return { tooLarge: true };
  }
  return { raw };
}
