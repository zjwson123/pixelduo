import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "./auth";
import { prisma } from "./prisma";
import { rateLimit, clientIp } from "./rate-limit";
import { captureError } from "./observability";

export async function requireUserId(): Promise<string> {
  const session = await getServerSession(authOptions);
  const uid = (session?.user as { id?: string } | undefined)?.id;
  if (!uid) throw new ApiError(401, "unauthorized");
  return uid;
}

// Account gate for credit-consuming actions: email must be verified first
// (anti-abuse — unverified accounts can't burn provider cost).
export async function requireVerifiedUser(): Promise<string> {
  const userId = await requireUserId();
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { emailVerified: true } });
  if (!user?.emailVerified) throw new ApiError(403, "verify-email-required");
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

export function fail(error: unknown) {
  if (error instanceof ApiError) {
    return NextResponse.json({ ok: false, error: error.message }, { status: error.status });
  }
  const msg = error instanceof Error ? error.message : "internal-error";
  // Expected business errors are not incidents; capture only unexpected 500s.
  const expected =
    msg.startsWith("invalid-") ||
    msg.startsWith("blocked:") ||
    msg.includes("insufficient") ||
    msg.includes("already") ||
    msg.includes("not-found") ||
    msg.includes("verify-email-required") ||
    msg.includes("rate-limited") ||
    msg.includes("unauthorized");
  if (!expected) {
    captureError(error, { error: msg });
    // Do not leak internal error details to API clients.
    return NextResponse.json({ ok: false, error: "internal-error" }, { status: 500 });
  }
  return NextResponse.json({ ok: false, error: msg }, { status: 500 });
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
      { status: 429, headers: { "Retry-After": String(r.retryAfterSec) } },
    );
  }
  return null;
}
