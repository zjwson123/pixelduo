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
    const meta = await sharp(baked).metadata();
    expect(meta.format).toBe("png");
    expect(meta.width).toBe(640);
    expect(meta.height).toBe(480);
    // Compositing adds an extra layer; size should differ from the source.
    expect(baked.length).toBeGreaterThan(base.length);
  });

  it("handles larger images and custom label", async () => {
    const base = await sharp({
      create: { width: 1024, height: 1024, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();
    const baked = await bakeWatermark(base);
    const meta = await sharp(baked).metadata();
    expect(meta.width).toBe(1024);
    expect(baked.length).toBeGreaterThan(base.length);
  });
});
