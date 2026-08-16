import { getStorage, newStorageKey } from "./storage";

export async function saveBase64Image(base64: string, ext = "png"): Promise<string> {
  const key = newStorageKey(ext);
  await getStorage().put(key, Buffer.from(base64, "base64"), `image/${ext}`);
  return key;
}

export async function saveRemoteImage(url: string): Promise<string> {
  // SSRF guard: only allow http/https URLs pointing to public hosts.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("invalid-url");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("invalid-url-scheme");
  }
  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname === "" ||
    hostname.startsWith("127.") ||
    hostname.startsWith("10.") ||
    hostname.startsWith("192.168.") ||
    hostname.startsWith("169.254.") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname) ||
    /^::1$/.test(hostname) ||
    /^fe80:/.test(hostname) ||
    hostname.startsWith("0.0.0.0")
  ) {
    throw new Error("blocked-internal-url");
  }
  // Timeout after 30s so a slow/hanging provider cannot stall the worker.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`download failed: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    // Cap at 25 MB to avoid unbounded memory consumption.
    if (buf.length > 25 * 1024 * 1024) throw new Error("image-too-large");
    const key = newStorageKey("png");
    await getStorage().put(key, buf, "image/png");
    return key;
  } finally {
    clearTimeout(timer);
  }
}

export function serveUrl(key: string): Promise<string> {
  return getStorage().publicUrl(key);
}

// Same-origin, cookie-authenticated URL for browser <img>/download. Unlike
// S3 presigned URLs, this always resolves from the visitor's browser and is
// ownership-scoped by the /api/files route.
export function serveUserUrl(key: string): string {
  return `/api/files/${key}`;
}
