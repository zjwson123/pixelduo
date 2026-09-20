import { errorResponse, ok, fail } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import { authenticateApiKey } from "@/lib/apikey";
import { prisma } from "@/lib/prisma";
import { serveUrl } from "@/lib/store";

export const dynamic = "force-dynamic";

// Poll a generation job's status and (when done) its image URLs.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const auth = await authenticateApiKey(req);
    if (!auth) return errorResponse({ ok: false, error: "unauthorized" }, { status: 401 });
    // Same account gate as the POST sibling and /api/files. Unreachable today —
    // a key can only be minted by POST /api/account/keys, which needs a verified
    // account, and no code path ever writes emailVerified back to null — so this
    // is alignment rather than a live hole: the invariant that makes it
    // unreachable is enforced nowhere near this route.
    if (!auth.emailVerified) {
      return errorResponse({ ok: false, error: "verify-email-required" }, { status: 403 });
    }
    // The POST is capped per key; the poll was not. Under the S3 driver each
    // poll re-signs one presigned URL per image (HMAC work, and the URL is
    // never cacheable because it changes), so an uncapped poll loop is a CPU
    // pump. 120/min leaves a normal 2-5s polling client far below the ceiling.
    const r = await rateLimit(`apikey-status:${auth.keyId}`, 120, 60_000);
    if (!r.ok) {
      return errorResponse(
        { ok: false, error: "rate-limited" },
        { status: 429, headers: { "Retry-After": String(r.retryAfterSec) } },
      );
    }
    const job = await prisma.job.findFirst({ where: { id: id, userId: auth.userId } });
    if (!job) return errorResponse({ ok: false, error: "job-not-found" }, { status: 404 });
    let images: string[];
    try {
      images = (JSON.parse(job.images) as unknown[]).filter((k): k is string => typeof k === "string");
      if (!Array.isArray(images)) images = [];
    } catch {
      images = [];
    }
    const served = await Promise.all(images.map((k) => serveUrl(k)));
    return ok({
      job: {
        id: job.id,
        status: job.status,
        model: job.model,
        quality: job.quality,
        count: job.count,
        costCredits: job.costCredits,
        images: served,
        error: job.error,
        createdAt: job.createdAt,
        finishedAt: job.finishedAt,
      },
    });
  } catch (e) {
    return fail(e);
  }
}
