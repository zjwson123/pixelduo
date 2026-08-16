import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getStorage } from "@/lib/storage";

function sniffContentType(buf: Uint8Array): string {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return "image/webp";
  }
  return "application/octet-stream";
}

// Authenticated, ownership-scoped image serving.
export async function GET(req: Request, { params }: { params: { key: string[] } }) {
  const key = params.key.join("/");
  const session = await getServerSession(authOptions);
  const uid = (session?.user as { id?: string } | undefined)?.id;
  if (!uid) return new NextResponse("unauthorized", { status: 401 });

  const image = await prisma.image.findFirst({ where: { userId: uid, url: key } });
  if (!image) return new NextResponse("not found", { status: 404 });

  const buf = await getStorage().get(key);
  if (!buf) return new NextResponse("not found", { status: 404 });

  const download = new URL(req.url).searchParams.get("download") === "1";
  // Sanitize filename to prevent header injection (CR/LF, quotes, path traversal).
  const rawName = key.split("/").pop() || "image";
  const baseName = rawName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 128) || "image";
  const headers: Record<string, string> = {
    "Content-Type": sniffContentType(buf),
    "Cache-Control": "private, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
  };
  if (download) {
    headers["Content-Disposition"] = `attachment; filename="${baseName}"`;
  }

  return new NextResponse(new Uint8Array(buf), {
    headers,
  });
}
