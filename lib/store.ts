import { getStorage, newStorageKey } from "./storage";

export async function saveBase64Image(base64: string, ext = "png"): Promise<string> {
  const key = newStorageKey(ext);
  await getStorage().put(key, Buffer.from(base64, "base64"), `image/${ext}`);
  return key;
}

export async function saveRemoteImage(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const key = newStorageKey("png");
  await getStorage().put(key, buf, "image/png");
  return key;
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
