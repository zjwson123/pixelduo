import sharp from "sharp";

// Bake a visible "AI 生成" badge into an image (bottom-right).
// Watermark is a plan perk: free plans get marked outputs, paid plans get
// clean files. gpt-image-2 has no built-in AI marker (unlike Seedream's
// provider-side "AI生成" mark, toggled via the API watermark param), so for
// free-tier gpt/wan images we bake our own badge here.
export async function bakeWatermark(buf: Buffer): Promise<Buffer> {
  const meta = await sharp(buf).metadata();
  const width = meta.width ?? 1024;
  const height = meta.height ?? width;
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
  return sharp(buf)
    .composite([{ input: Buffer.from(svg), gravity: "southeast" }])
    .png()
    .toBuffer();
}
