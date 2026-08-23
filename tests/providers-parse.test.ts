import { describe, expect, it } from "vitest";
import { parseSeedanceVideoUrl } from "../lib/providers";

describe("parseSeedanceVideoUrl", () => {
  it("extracts the URL from Ark's string shape (the real format, verified 2026-08-23)", () => {
    expect(parseSeedanceVideoUrl("https://ark-acg-cn-beijing.tos-cn-beijing.volces.com/v.mp4"))
      .toBe("https://ark-acg-cn-beijing.tos-cn-beijing.volces.com/v.mp4");
  });

  it("still handles an array-of-objects shape if Ark ever changes", () => {
    expect(parseSeedanceVideoUrl([{ url: "https://x/v.mp4" }])).toBe("https://x/v.mp4");
    expect(parseSeedanceVideoUrl([{}])).toBeUndefined();
  });

  it("returns undefined for missing or empty values", () => {
    expect(parseSeedanceVideoUrl(undefined)).toBeUndefined();
    expect(parseSeedanceVideoUrl("")).toBeUndefined();
  });
});
