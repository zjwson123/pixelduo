import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateImages, laneCountFor } from "../lib/providers";

// The "both" mode fans ONE count out to two lanes (gpt + seedream). The worker
// used to pass its resume counter — expectedTotal − saved, i.e. the FULL 2N for
// this non-checkpointing path — straight into generateImages, which handed it
// to each lane: a count=1 job (charged 14 credits for one gpt + one seedream)
// generated two of each and stored four images, so every "both" job cost the
// operator roughly twice what the caller paid. MOCK_IMAGE_PROVIDER cannot catch
// it — the mock short-circuits this branch and returns `count` images for the
// model name it was handed — so this test drives the real code with a stubbed
// fetch and counts the calls that would have been billed.

const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const origFetch = globalThis.fetch;
const origModelverse = process.env.MODELVERSE_IMAGE_API_KEY;
const origArk = process.env.ARK_IMAGE_API_KEY;
const origMock = process.env.MOCK_IMAGE_PROVIDER;

interface Call {
  url: string;
  n: number;
}

let calls: Call[] = [];

beforeAll(() => {
  // ci-local.sh and the e2e job export MOCK_IMAGE_PROVIDER=1, which
  // short-circuits generateImages before the "both" branch — the exact reason
  // this regression shipped unseen. This test must drive the real dispatcher.
  delete process.env.MOCK_IMAGE_PROVIDER;
  process.env.MODELVERSE_IMAGE_API_KEY = "test-key";
  process.env.ARK_IMAGE_API_KEY = "test-key";
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { n?: number; model?: string };
    calls.push({ url: String(url), n: body.n ?? 0 });
    return new Response(JSON.stringify({ data: [{ b64_json: TINY_PNG_B64 }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = origFetch;
  if (origMock) process.env.MOCK_IMAGE_PROVIDER = origMock;
  else delete process.env.MOCK_IMAGE_PROVIDER;
  if (origModelverse) process.env.MODELVERSE_IMAGE_API_KEY = origModelverse;
  else delete process.env.MODELVERSE_IMAGE_API_KEY;
  if (origArk) process.env.ARK_IMAGE_API_KEY = origArk;
  else delete process.env.ARK_IMAGE_API_KEY;
});

describe("laneCountFor", () => {
  it("halves a two-lane job and passes single-lane models through", () => {
    expect(laneCountFor("both", 2)).toBe(1);
    expect(laneCountFor("both", 4)).toBe(2);
    expect(laneCountFor("both", 8)).toBe(4);
    // Always one lane: the count IS the image count.
    expect(laneCountFor("gpt", 3)).toBe(3);
    expect(laneCountFor("seedream", 1)).toBe(1);
    expect(laneCountFor("seedance", 1)).toBe(1);
  });
});

describe("both-mode delivery matches what the caller paid for", () => {
  it("generates 2N images (N per lane) for a job that owes 2N", async () => {
    for (const jobCount of [1, 2]) {
      calls = [];
      const remaining = jobCount * 2; // what the worker owes: 2N images
      const images = await generateImages({
        model: "both",
        quality: "medium",
        count: laneCountFor("both", remaining),
        prompt: "a lighthouse at dusk",
      });
      // 2N images, billed to the caller as N gpt + N seedream…
      expect(images).toHaveLength(remaining);
      // …which is exactly 2N provider calls, N per gateway.
      expect(calls).toHaveLength(remaining);
      expect(calls.filter((c) => c.url.includes("modelverse"))).toHaveLength(jobCount);
      expect(calls.filter((c) => c.url.includes("volces"))).toHaveLength(jobCount);
      // Each call asks for a single image (the lanes loop, they don't batch).
      expect(calls.every((c) => c.n === 1)).toBe(true);
    }
  });

  it("would generate 4N for the same job if the resume counter were passed through", async () => {
    // The regression in one assertion: passing `remaining` (2N) is what the
    // worker used to do, and it produces twice the images the caller paid for.
    calls = [];
    const jobCount = 1;
    const images = await generateImages({
      model: "both",
      quality: "medium",
      count: jobCount * 2,
      prompt: "a lighthouse at dusk",
    });
    expect(images).toHaveLength(4 * jobCount);
    expect(calls).toHaveLength(4 * jobCount);
  });
});
