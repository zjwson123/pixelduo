import { requireUserId, ok, fail, enforceRateLimit } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { serveUserUrl } from "@/lib/store";

export const dynamic = "force-dynamic";

// List templates with optional filtering. Supports category, search, and
// featured flags. Pagination via ?page=&pageSize= (default 30, max 60).
// Requires an authenticated session — templates contain curated prompts
// that are a product asset, not public data.
export async function GET(req: Request) {
  try {
    await requireUserId();
    const limited = await enforceRateLimit(req, "templates", 60, 60_000);
    if (limited) return limited;
    const url = new URL(req.url);
  const cat = url.searchParams.get("cat"); // category label (Chinese short)
  const q = url.searchParams.get("q"); // free-text search on title + prompt
  const featured = url.searchParams.get("featured") === "1";
  const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10));
  const pageSize = Math.min(60, Math.max(1, parseInt(url.searchParams.get("pageSize") ?? "30", 10)));

  const where: Prisma.TemplateWhereInput = {};
  if (cat && cat !== "全部") where.cat = cat;
  if (featured) where.featured = true;
  if (q) {
    where.OR = [
      { title: { contains: q, mode: "insensitive" } },
      { prompt: { contains: q, mode: "insensitive" } },
    ];
  }

  const [templates, total] = await Promise.all([
    prisma.template.findMany({
      where,
      orderBy: [{ featured: "desc" }, { id: "asc" }],
      take: pageSize,
      skip: (page - 1) * pageSize,
    }),
    prisma.template.count({ where }),
  ]);

  return ok({
    templates: templates.map((t) => ({ ...t, img: serveUserUrl(t.img) })),
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  });
  } catch (e) {
    return fail(e);
  }
}
