import { requireAdmin } from "@/lib/admin";
import { ok, fail } from "@/lib/api";
import { prisma } from "@/lib/prisma";

export async function GET(req: Request) {
  try {
    await requireAdmin();
    const url = new URL(req.url);
    const userId = url.searchParams.get("userId") ?? undefined;
    const take = 50;
    const images = await prisma.image.findMany({
      where: userId ? { userId } : undefined,
      orderBy: { createdAt: "desc" },
      take,
      select: { id: true, userId: true, url: true, model: true, prompt: true, createdAt: true },
    });
    return ok({ images });
  } catch (e) {
    return fail(e);
  }
}
