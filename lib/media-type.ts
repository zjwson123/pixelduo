// One place decides what an object's bytes are.
//
// Three places care: /api/files sniffs the first chunk so it can serve a correct
// Content-Type with `X-Content-Type-Options: nosniff`, the S3 driver records a
// content type at PUT time (which is what a PRESIGNED URL hands back to an API
// client and what the external moderation detector sees), and a mid-file Range
// response has no magic bytes to inspect — it falls back to the key's extension.
//
// The put() sites used to pass a hardcoded "image/png" / "video/mp4" regardless
// of what the provider actually returned, so a WebP payload was stored (and
// presigned) as image/png: a client trusting the header, or a detector rejecting
// a mismatch, breaks on a file that /api/files serves correctly — the two paths
// disagreed because only one of them looked.

export type MediaKind = "image/png" | "image/jpeg" | "image/webp" | "video/mp4" | "video/webm";

/** Content type from the leading bytes, or null when nothing matches. */
export function sniffContentType(buf: Uint8Array): MediaKind | null {
  // Video: MP4 — a top-level `ftyp` box starts at byte 4 (ISOBMFF). ANY major
  // brand is accepted (pass 70): the check used to require exactly `isom`, so a
  // legitimate `mp42`, `avc1`, `M4V `, `iso5` or `dash` file — every one of
  // which a provider or an ffmpeg build can produce — sniffed as null and was
  // stored under the caller's declared type. In the image lane that meant video
  // bytes stored (and presigned) as `image/png`; in the video lane it defeated
  // the delivery check in saveRemoteVideo, which must recognise the container.
  // The brand is a 4CC code, not a format guarantee: the box structure is what
  // this identifies, and a parser that needs the code reads it from the box.
  if (
    buf.length >= 12 &&
    buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70
  ) {
    return "video/mp4";
  }
  // Video: WebM/Matroska EBML header.
  if (buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
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
  return null;
}

/** The extension the key should carry for a sniffed type. */
export function extensionForContentType(type: MediaKind): string {
  switch (type) {
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "video/webm":
      return "webm";
    case "video/mp4":
      return "mp4";
    default:
      return "png";
  }
}

/**
 * Content type from the key's extension. Only for a response that cannot be
 * sniffed — a Range that does not start at byte 0 — since keys are minted by
 * newStorageKey() from the sniffed type (lib/store.ts, lib/providers).
 */
export function contentTypeFromKey(key: string): MediaKind | null {
  const m = /\.([a-z0-9]{2,4})$/i.exec(key);
  switch ((m?.[1] ?? "").toLowerCase()) {
    case "mp4":
      return "video/mp4";
    case "webm":
      return "video/webm";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    default:
      return null;
  }
}

/**
 * Store-time type: the bytes decide, the caller's expectation is the fallback
 * (a payload whose header we do not recognise is still stored — refusing would
 * break delivery of a format we merely do not sniff — but under the type the
 * caller declared).
 */
export function storeContentType(buf: Uint8Array, declared: MediaKind): MediaKind {
  return sniffContentType(buf) ?? declared;
}
