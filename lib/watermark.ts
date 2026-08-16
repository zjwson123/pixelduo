import sharp from "sharp";

// Bake a visible "AI 生成" badge into an image (bottom-right).
// gpt-image-2 outputs carry no built-in AI marker (unlike Seedream's
// "AI生成" watermark), so free-tier gpt images get a baked label.
// Paid-tier watermark removal is a future product feature.
export async function bakeWatermark(buf: Buffer): Promise<Buffer> {
  const meta = await sharp(buf).metadata();
  const width = meta.width ?? 1024;
  const fontSize = Math.max(24, Math.round(width / 32));
  const pad = Math.max(12, Math.round(width / 60));
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
