import { requireUserId, ApiError } from "@/lib/api";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getStorage } from "@/lib/storage";

function sniffContentType(buf: Uint8Array): string {
  // Video: MP4
  if (
    buf.length >= 12 &&
    buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70 &&
    buf[8] === 0x69 && buf[9] === 0x73 && buf[10] === 0x6f && buf[11] === 0x6d
  ) {
    return "video/mp4";
  }
  // Video: WebM
  if (
    buf.length >= 4 &&
    buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3
  ) {
    return "video/webm";
  }
  // Image: JPEG
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  // Image: PNG
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  // Image: WebP (RIFF....WEBP)
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return "image/webp";
  }
  return "application/octet-stream";
}

// Authenticated, ownership-scoped image/video serving.
// Template images (from the Explore gallery) are shared across all users —
// any logged-in user can fetch them by key, but the key must exist in the
// Template table so arbitrary file enumeration is impossible.
export async function GET(req: Request, { params }: { params: Promise<{ key: string[] }> }) {
  const { key: keyParts } = await params;
  const key = keyParts.join("/");
  // requireUserId (not raw getServerSession) so a partial 2FA session or a
  // stale JWT revoked via sessionVersion can't read files.
  let uid: string;
  try {
    uid = await requireUserId();
  } catch (e) {
    if (e instanceof ApiError) return new NextResponse(e.message, { status: e.status });
    throw e;
  }

  // 1. User-owned generated image/video
  const image = await prisma.image.findFirst({ where: { userId: uid, url: key } });
  // 2. Shared template image (Explore gallery) — any logged-in user
  if (!image) {
    const template = await prisma.template.findFirst({ where: { img: key }, select: { id: true } });
    if (!template) return new NextResponse("not found", { status: 404 });
  }

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
