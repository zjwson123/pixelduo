import { z } from "zod";
import { requireAdmin } from "@/lib/admin";
import { ok, fail, readBodyCapped, enforceRateLimit, enforceUserRateLimit } from "@/lib/api";
import { prisma } from "@/lib/prisma";

const schema = z.object({ role: z.enum(["user", "admin"]) });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const adminId = await requireAdmin();
    // Privilege changes carry their own per-IP + per-admin ceiling; this was
    // the second of the only two body-reading routes with no limit at all.
    const limited = await enforceRateLimit(req, "admin-role", 30, 60_000);
    if (limited) return limited;
    const adminLimited = await enforceUserRateLimit(adminId, "admin-role", 30, 60_000);
    if (adminLimited) return fail(adminLimited);
    const bodyRaw = await readBodyCapped(req, 8 * 1024);
    if ("tooLarge" in bodyRaw) return new Response("payload too large", { status: 413 });
    const body = schema.parse(JSON.parse(bodyRaw.raw));
    if (id === adminId && body.role !== "admin") {
      return fail(new Error("cannot-demote-self"));
    }
    // P2025 on the update below would 500; unknown ids are a plain 404.
    const target = await prisma.user.findUnique({ where: { id }, select: { id: true } });
    if (!target) return fail(new Error("user-not-found"));
    const updated = await prisma.user.update({
      where: { id: id },
      data: { role: body.role },
      select: { id: true, role: true },
    });
    return ok({ user: updated });
  } catch (e) {
    if (e instanceof z.ZodError) return fail(new Error("invalid-input"));
    return fail(e);
  }
}
