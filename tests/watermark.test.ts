import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { bakeWatermark } from "../lib/watermark";

describe("bakeWatermark", () => {
  it("produces a valid PNG with the badge composited", async () => {
    const base = await sharp({
      create: { width: 640, height: 480, channels: 3, background: { r: 200, g: 200, b: 200 } },
    })
      .png()
      .toBuffer();
    const baked = await bakeWatermark(base);
    const meta = await sharp(baked.buf).metadata();
    expect(baked.baked).toBe(true);
    expect(meta.format).toBe("png");
    expect(meta.width).toBe(640);
    expect(meta.height).toBe(480);
    // Compositing adds an extra layer; size should differ from the source.
    expect(baked.buf.length).toBeGreaterThan(base.length);
  });

  it("handles larger images and custom label", async () => {
    const base = await sharp({
      create: { width: 1024, height: 1024, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();
    const baked = await bakeWatermark(base);
    const meta = await sharp(baked.buf).metadata();
    expect(baked.baked).toBe(true);
    expect(meta.width).toBe(1024);
    expect(baked.buf.length).toBeGreaterThan(base.length);
  });

  it("marks a panorama the nominal badge does not fit in", async () => {
    // 4096×256 is ~16:1: the badge's nominal band (fontSize + 2·pad, both derived
    // from the WIDTH) is taller than the image, and the old code returned the
    // input unchanged while the worker recorded `baked: true` — a free-tier
    // output that shipped without the badge and was never re-checked. The band is
    // scaled to the canvas now, so the bytes must change.
    const base = await sharp({
      create: { width: 4096, height: 256, channels: 3, background: { r: 30, g: 30, b: 30 } },
    })
      .png()
      .toBuffer();
    const baked = await bakeWatermark(base);
    expect(baked.baked).toBe(true);
    expect(baked.buf.equals(base)).toBe(false);
    // The composited band really is in the pixels: compare the bottom strip
    // against the source's.
    const strip = await sharp(baked.buf)
      .extract({ left: 0, top: 256 - 40, width: 4096, height: 40 })
      .raw()
      .toBuffer();
    const orig = await sharp(base)
      .extract({ left: 0, top: 256 - 40, width: 4096, height: 40 })
      .raw()
      .toBuffer();
    expect(strip.equals(orig)).toBe(false);
  });

  it("reports an unbadgeable canvas instead of claiming it was marked", async () => {
    // 1×1 is what MOCK_IMAGE_PROVIDER stores; sharp cannot composite a badge
    // bigger than the canvas — this used to fail every mock gpt job. The caller
    // has to be told the badge is NOT on the file (scripts/worker.ts records the
    // flag in the job checkpoint, so a wrong `true` is permanent).
    const base = await sharp({
      create: { width: 1, height: 1, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();
    const baked = await bakeWatermark(base);
    expect(baked.baked).toBe(false);
    expect(baked.buf.equals(base)).toBe(true);
  });
});

it("rejects non-raster input — SVG never reaches librsvg", async () => {
  // Provider bytes are untrusted; an SVG payload would hit librsvg's XML
  // parser (entity/filter abuse surface).
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>');
  await expect(bakeWatermark(svg)).rejects.toThrow("unsupported-image-format");
});
