import sharp from "sharp";
import { isRasterImage, MAX_INPUT_PIXELS } from "../lib/watermark";

// Validate bytes downloaded for an Explore template before they are stored.
//
// `scripts/import-cases.ts` treats the upstream repository as hostile for
// file paths, symlinks and `sourceUrl`, but the image BYTES were stored
// unchecked: `storeContentType` only labels them. A poisoned case image could
// therefore be an SVG/HTML payload hosted under the app's own origin (served
// as image/jpeg + nosniff, so not script XSS — but arbitrary content
// distribution from a trusted host), or a decompression bomb whose dimensions
// crash every visitor's tab as the Explore grid renders it. Template responses
// are also cached `immutable` for a year, so a bad payload persists client-side.
//
// The app already decodes untrusted provider images through this exact pair:
// raster magic bytes first (an SVG must never reach librsvg), then a sharp
// header read bounded by MAX_INPUT_PIXELS. Mirror it here so an imported case
// is the same kind of object as a generated image.
export async function isSafeCaseImage(buf: Buffer): Promise<boolean> {
  if (!isRasterImage(buf)) return false;
  try {
    const meta = await sharp(buf, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
    if (!meta.width || !meta.height) return false;
    return meta.width * meta.height <= MAX_INPUT_PIXELS;
  } catch {
    // Truncated/corrupt headers, an unsupported codec, over the pixel cap.
    return false;
  }
}
