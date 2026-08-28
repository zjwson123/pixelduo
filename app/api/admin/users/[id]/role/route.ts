import { z } from "zod";
import { requireAdmin } from "@/lib/admin";
import { ok, fail } from "@/lib/api";
import { prisma } from "@/lib/prisma";

const schema = z.object({ role: z.enum(["user", "admin"]) });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const adminId = await requireAdmin();
    const body = schema.parse(await req.json());
    if (id === adminId && body.role !== "admin") {
      return fail(new Error("cannot-demote-self"));
    }
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
