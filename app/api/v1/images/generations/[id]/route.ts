import { NextResponse } from "next/server";
import { ok, fail } from "@/lib/api";
import { authenticateApiKey } from "@/lib/apikey";
import { prisma } from "@/lib/prisma";
import { serveUrl } from "@/lib/store";

export const dynamic = "force-dynamic";

// Poll a generation job's status and (when done) its image URLs.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const auth = await authenticateApiKey(req);
    if (!auth) return new NextResponse(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401 });
    const job = await prisma.job.findFirst({ where: { id: id, userId: auth.userId } });
    if (!job) return new NextResponse(JSON.stringify({ ok: false, error: "job-not-found" }), { status: 404 });
    let images: string[];
    try {
      images = JSON.parse(job.images) as string[];
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
