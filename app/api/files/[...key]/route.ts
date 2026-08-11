import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getStorage } from "@/lib/storage";

// Authenticated, ownership-scoped image serving.
export async function GET(_req: Request, { params }: { params: { key: string[] } }) {
  const key = params.key.join("/");
  const session = await getServerSession(authOptions);
  const uid = (session?.user as { id?: string } | undefined)?.id;
  if (!uid) return new NextResponse("unauthorized", { status: 401 });

  const image = await prisma.image.findFirst({ where: { userId: uid, url: key } });
  if (!image) return new NextResponse("not found", { status: 404 });

  const buf = await getStorage().get(key);
  if (!buf) return new NextResponse("not found", { status: 404 });

  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
