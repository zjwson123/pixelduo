import { enforceRateLimit, errorResponse, ok, fail, refuseNul } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import { authenticateApiKey } from "@/lib/apikey";
import { prisma } from "@/lib/prisma";
import { serveUrl } from "@/lib/store";

export const dynamic = "force-dynamic";

// Poll a generation job's status and (when done) its image URLs.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    // A %00 in the path decodes to a real U+0000 → Prisma text lookup →
    // SQLSTATE 22021 → the masked 500 + captured incident seen on /api/jobs;
    // refused as the client error it is (see refuseNul in lib/api.ts).
    refuseNul(id);
    // Same pre-credential address leg as the POST sibling: the per-key bucket
    // below only applies once a key resolves, so it never bounds the
    // invalid-key flood that makes authenticateApiKey do its lookups. 600/min
    // matches the account-keyed cap on /api/jobs, so a real polling client
    // (2.5-5s interval, several jobs) stays far below it.
    const ipLimited = await enforceRateLimit(req, "v1-poll", 600, 60_000);
    if (ipLimited) return ipLimited;
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
        {
          status: 429,
          headers: {
            "Retry-After": String(r.retryAfterSec),
            "RateLimit-Limit": "120",
            "RateLimit-Remaining": "0",
          },
        },
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
