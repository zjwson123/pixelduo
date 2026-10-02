import { requireUserId, ok, fail, enforceUserRateLimit, clampPage, queryText } from "@/lib/api";
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
    const userId = await requireUserId();
    // Account-keyed, like every sibling read (gallery 120/min, jobs 600/min).
    // It was the last authenticated read keyed ONLY on the source address, which
    // made Explore the cheapest way to deny a co-tenant: 60 requests/min from
    // one account emptied `templates:<egress>` and every neighbour behind the
    // same NAT got 429 on the gallery, while the caller's own budget was lifted
    // by rotating IPs. See enforceUserRateLimit.
    const limited = await enforceUserRateLimit(userId, "templates", 60, 60_000);
    if (limited) return fail(limited);
    const url = new URL(req.url);
  // Both are free-text inputs feeding an unindexed `contains` scan, so they are
  // bounded before they reach the query (there is no injection risk — the scan
  // is the cost). A NUL is refused rather than sliced: PostgreSQL's text type
  // rejects U+0000 with 22021, which surfaced as a masked 500 plus a captured
  // incident, once per request, for any signed-in account.
  const cat = queryText(url.searchParams.get("cat"), 40); // category label (Chinese short)
  const q = queryText(url.searchParams.get("q"), 100); // free-text search on title + prompt
  const featured = url.searchParams.get("featured") === "1";
  // NaN-guard: garbage ?page= must fall back to 1, not skip: NaN. clampPage
  // also bounds the top end, where a huge finite value produced a skip the
  // query engine rejects — a masked 500 instead of a graceful page 1.
  const page = clampPage(url.searchParams.get("page"));
  const rawPageSize = Number.parseInt(url.searchParams.get("pageSize") ?? "30", 10);
  const pageSize = Number.isFinite(rawPageSize) ? Math.min(60, Math.max(1, rawPageSize)) : 30;

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
    // Storage keys (imported Explore cases) resolve through the authenticated
    // /api/files route; the bundled seed set ships in public/templates, so its
    // absolute path is passed through untouched. Wrapping those in
    // serveUserUrl produced "/api/files//templates/x.png" — Next collapses the
    // double slash with a 308, the lookup then misses Template.img (stored
    // with the leading slash) and every seeded thumbnail 404s.
    templates: templates.map((t) => ({ ...t, img: t.img.startsWith("/") ? t.img : serveUserUrl(t.img) })),
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  });
  } catch (e) {
    return fail(e);
  }
}
