import sharp from "sharp";

// Raster magic bytes only — provider bytes are untrusted input to libvips,
// and an SVG payload would reach librsvg's XML parser (entity/filter abuse).
function isRasterImage(buf: Buffer): boolean {
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true; // PNG
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true; // JPEG
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return true; // WebP
  }
  return false;
}

// Pixel-count cap: sharp's ~268MP default admits a ~1GB RGBA decompression
// bomb, and the 100MP ceiling this replaced was still 6× larger than anything a
// provider can legitimately return (Seedream tops out at 4096² ≈ 16.7MP, and a
// 100MP PNG of solid colour is ~200KB of deflate — far under the 25MB download
// cap). One such image from a hostile or compromised provider made the bake
// allocate ~400MB RGBA plus the output image and the PNG encoder in a worker
// that never budgeted for it. 20MP stays above every real output and bounds the
// allocation at ~80MB. lib/safety.ts shares this ceiling for the same reason.
export const MAX_INPUT_PIXELS = 20_000_000;

// Bake a visible "AI 生成" badge into an image (bottom-right).
// Watermark is a plan perk: free plans get marked outputs, paid plans get
// clean files. gpt-image-2 has no built-in AI marker (unlike Seedream's
// provider-side "AI生成" mark, toggled via the API watermark param), so for
// free-tier gpt/wan images we bake our own badge here.
export async function bakeWatermark(buf: Buffer): Promise<Buffer> {
  if (!isRasterImage(buf)) throw new Error("unsupported-image-format");
  const meta = await sharp(buf, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
  // Provider-controlled dimensions flow into the badge SVG's raster size —
  // clamp so a lying header can't request a multi-GB librsvg allocation.
  const width = Math.min(meta.width ?? 1024, 8192);
  const height = Math.min(meta.height ?? width, 8192);
  const fontSize = Math.max(24, Math.round(width / 32));
  const pad = Math.max(12, Math.round(width / 60));
  // Images too small to carry a readable badge (e.g. the 1×1 mock
  // placeholders in tests) pass through untouched — sharp cannot composite
  // a badge larger than the canvas anyway.
  if (height < fontSize + pad * 2) return buf;
  const label = process.env.WATERMARK_TEXT || "PixelDuo · AI 生成";
  // Escape XML special characters to prevent SVG injection from env var.
  const safeLabel = label
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
  const svg = `<svg width="${width}" height="${fontSize + pad * 2}" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" rx="${Math.round(fontSize / 2)}" fill="rgba(0,0,0,0.55)"/>
    <text x="50%" y="50%" font-family="system-ui, -apple-system, 'PingFang SC', sans-serif" font-size="${fontSize}" fill="rgba(255,255,255,0.92)" text-anchor="middle" dominant-baseline="central">${safeLabel}</text>
  </svg>`;
  // Same cap as the metadata read above, and it has to be repeated here: this is
  // a second, independent pipeline over the same untrusted buffer, and its
  // default is sharp's ~268MP. Today the metadata() call throws first for
  // anything over the cap, so the pipeline is unreachable for a bomb — but that
  // is an accident of ordering, not a property of this line, and any early
  // return added between the two re-opens a ~1GB decode of a few hundred KB of
  // deflate. The ceiling belongs on every sharp() call that touches provider
  // bytes (lib/safety.ts does the same).
  return sharp(buf, { limitInputPixels: MAX_INPUT_PIXELS })
    .composite([{ input: Buffer.from(svg), gravity: "southeast" }])
    .png()
    .toBuffer();
}
