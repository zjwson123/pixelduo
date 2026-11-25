import { describe, expect, it, vi } from "vitest";

// Pass 70 — a provider's "succeeded" poll hands us a URL, not a video. Until
// this pass saveRemoteVideo stored whatever 200 body answered (a CDN's HTML
// block page, an expired-token page, a relay's JSON error) under the declared
// video/mp4, the worker completed the job, charged the caller and delivered a
// file no player opens — no output audit exists on the video lane to notice.
// The guard is the container magic; these tests drive the real function with
// the network and storage stubbed.

const state: { reply: Buffer } = { reply: Buffer.from("<html><body>blocked by CDN</body></html>") };
const puts: Array<{ key: string; type?: string }> = [];

vi.mock("../lib/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/store")>();
  return { ...actual, fetchPublicBuffer: vi.fn(async () => state.reply) };
});

vi.mock("../lib/storage", () => ({
  getStorage: () => ({
    put: async (key: string, _buf: Buffer, type?: string) => {
      puts.push({ key, type });
    },
  }),
  newStorageKey: (ext: string) => `img/probe-${Math.random().toString(36).slice(2)}.${ext}`,
}));

const { saveRemoteVideo, requireB64 } = await import("../lib/providers");
const { isPermanentProviderError } = await import("../lib/worker-errors");

function isoBmff(brand: string): Buffer {
  const b = Buffer.alloc(32);
  b.writeUInt32BE(24, 0);
  b.write("ftyp", 4, "latin1");
  b.write(brand, 8, "latin1");
  return b;
}

describe("pass 70 — saveRemoteVideo refuses a non-video 200 body", () => {
  it("does not store or deliver an HTML error page", async () => {
    state.reply = Buffer.from("<html><body>blocked by CDN</body></html>");
    puts.length = 0;
    await expect(saveRemoteVideo("https://provider.example/v.mp4")).rejects.toThrow(/not-a-video/);
    expect(puts).toHaveLength(0);
    // Terminal: a retry re-downloads the same page and the provider is not
    // re-billed for a download, but the caller must be refunded immediately
    // instead of waiting through three backoffs.
    expect(isPermanentProviderError("not-a-video: the provider's video URL did not return an MP4/WebM container")).toBe(true);
  });

  it("stores a real MP4 regardless of its major brand", async () => {
    state.reply = isoBmff("mp42");
    puts.length = 0;
    const key = await saveRemoteVideo("https://provider.example/v.mp4");
    expect(key.endsWith(".mp4")).toBe(true);
    expect(puts).toEqual([{ key, type: "video/mp4" }]);
  });

  it("accepts a legal non-ftyp opener (moov-first) rather than refunding a real clip", async () => {
    const moov = Buffer.alloc(32);
    moov.writeUInt32BE(24, 0);
    moov.write("moov", 4, "latin1");
    state.reply = moov;
    puts.length = 0;
    const key = await saveRemoteVideo("https://provider.example/v.mp4");
    expect(key.endsWith(".mp4")).toBe(true);
    expect(puts).toEqual([{ key, type: "video/mp4" }]);
  });

  it("stores a WebM segment as video/webm", async () => {
    const webm = Buffer.alloc(32);
    webm.set([0x1a, 0x45, 0xdf, 0xa3], 0); // EBML header
    state.reply = webm;
    puts.length = 0;
    const key = await saveRemoteVideo("https://provider.example/v.webm");
    expect(key.endsWith(".webm")).toBe(true);
    expect(puts).toEqual([{ key, type: "video/webm" }]);
  });
});

describe("pass 70 — a non-string b64_json is a broken response, not a transient fault", () => {
  it("refuses values Buffer.from would throw on, with the classifier's wording", () => {
    expect(() => requireB64([{ b64_json: 123 }], "gpt-image-2")).toThrow(/returned no b64_json/);
    expect(() => requireB64([{ b64_json: {} }], "seedream")).toThrow(/returned no b64_json/);
    expect(() => requireB64([], "gpt-image-2 edit")).toThrow(/returned no b64_json/);
    expect(() => requireB64(undefined, "seedream")).toThrow(/returned no b64_json/);
    // The message the worker classifies must stay terminal.
    expect(isPermanentProviderError("gpt-image-2 returned no b64_json")).toBe(true);
    expect(requireB64([{ b64_json: "aGVsbG8=" }], "gpt-image-2")).toBe("aGVsbG8=");
  });
});
