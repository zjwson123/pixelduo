import { ok } from "@/lib/api";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET() {
  const templates = await prisma.template.findMany({ orderBy: { id: "asc" } });
  return ok({ templates });
}
