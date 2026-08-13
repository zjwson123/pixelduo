import { requireUserId, ok, fail } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { serveUserUrl } from "@/lib/store";

export async function GET() {
  try {
    const userId = await requireUserId();
    const rows = await prisma.image.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 60,
    });
    const served = rows.map((i) => ({ ...i, url: serveUserUrl(i.url) }));
    return ok({ images: served });
  } catch (e) {
    return fail(e);
  }
}
