import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateImages, editWithGpt, createVideoTask, saveRemoteVideo } from "../lib/providers";
import { modelCost } from "../lib/cost";
import { getStorage } from "../lib/storage";

// 1×1 transparent PNG — what the mock provider stores.
const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const orig = {
  mock: process.env.MOCK_IMAGE_PROVIDER,
  ark: process.env.ARK_IMAGE_API_KEY,
  modelverse: process.env.MODELVERSE_IMAGE_API_KEY,
};

afterEach(() => {
  vi.restoreAllMocks();
  if (orig.mock) process.env.MOCK_IMAGE_PROVIDER = orig.mock;
  else delete process.env.MOCK_IMAGE_PROVIDER;
  if (orig.ark) process.env.ARK_IMAGE_API_KEY = orig.ark;
  else delete process.env.ARK_IMAGE_API_KEY;
  if (orig.modelverse) process.env.MODELVERSE_IMAGE_API_KEY = orig.modelverse;
  else delete process.env.MODELVERSE_IMAGE_API_KEY;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// Under MOCK_IMAGE_PROVIDER the dispatcher short-circuits before every real
// provider branch, so a test that drives a real branch must neutralise it —
// ci-local.sh and the e2e job export it process-wide.
function fetchSpy(response: () => Response) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => response());
}

describe("mock provider fidelity", () => {
  beforeEach(() => {
    process.env.MOCK_IMAGE_PROVIDER = "1";
  });

  // The mock used to tag its stub with the REQUESTED model id, so a "both" job
  // produced images labelled "both" — and the worker prices every image through
  // modelCost(), which throws unknown-model:both. Every "both" job under the
  // documented no-key dev/CI configuration therefore failed terminally and
  // refunded, which is also why the real branch's 4N-for-2N over-delivery went
  // unnoticed for two passes: the one configuration CI runs could not complete a
  // "both" job at all.
  it("emits concrete per-lane models for `both` so the worker can price them", async () => {
    const images = await generateImages({ model: "both", quality: "medium", count: 1, prompt: "mock both" });
    // Two lanes, one image each — the count the caller paid 2× for.
    expect(images.map((i) => i.model).sort()).toEqual(["gpt", "seedream"]);
    for (const img of images) {
      expect(modelCost(img.model, "medium").credits).toBeGreaterThan(0);
      expect(await getStorage().get(img.key)).not.toBeNull();
    }
  });

  it("tags single-model stubs with that model", async () => {
    const images = await generateImages({ model: "seedream", quality: "medium", count: 2, prompt: "mock one" });
    expect(images.map((i) => i.model)).toEqual(["seedream", "seedream"]);
  });
});

describe("provider call hardening", () => {
  beforeEach(() => {
    delete process.env.MOCK_IMAGE_PROVIDER;
    process.env.MODELVERSE_IMAGE_API_KEY = "test-modelverse-key";
    process.env.ARK_IMAGE_API_KEY = "test-ark-key";
  });

  // A hostile or compromised provider answering 307 could pick the address the
  // follow-up request (and its Authorization header) goes to, from inside our
  // network and with no port restriction. No provider endpoint legitimately
  // redirects, so every call site pins the init.
  it("never follows provider redirects", async () => {
    const spy = fetchSpy(() => jsonResponse({ data: [{ b64_json: TINY_PNG }] }));
    await generateImages({ model: "gpt", quality: "low", count: 1, prompt: "no redirects" });
    expect(spy.mock.calls.length).toBeGreaterThan(0);
    for (const call of spy.mock.calls) {
      expect((call[1] as RequestInit | undefined)?.redirect).toBe("manual");
    }
  });

  // The task id is stored in Job.providerTaskId, logged on every poll and
  // interpolated into the poll URL — all of it unbounded before this bound.
  it("rejects an implausibly long provider task id", async () => {
    fetchSpy(() => jsonResponse({ id: "x".repeat(5_000) }));
    await expect(
      createVideoTask({ model: "seedance", prompt: "bound me", durationSec: 5 }),
    ).rejects.toThrow(/task id/);
  });

  it("accepts a normal provider task id", async () => {
    fetchSpy(() => jsonResponse({ id: "cgt-2026-09-18-abcdef" }));
    await expect(createVideoTask({ model: "seedance", prompt: "ok", durationSec: 5 })).resolves.toMatchObject({
      taskId: "cgt-2026-09-18-abcdef",
    });
  });

  // The edit lane was the only image path that checkpointed nothing: a transient
  // failure after the paid edits call retried from zero and re-billed it, and a
  // job that finally failed left the generated object referenced by nothing
  // (failJob reclaims only what Job.images knows about).
  it("checkpoints the edit lane through the dispatcher", async () => {
    fetchSpy(() => jsonResponse({ data: [{ b64_json: TINY_PNG }] }));
    const seen: string[] = [];
    const images = await generateImages({
      model: "gpt",
      quality: "low",
      count: 1,
      prompt: "edit me",
      imageBase64: TINY_PNG,
      onImage: async (img) => {
        expect(await getStorage().get(img.key)).not.toBeNull();
        seen.push(img.key);
      },
    });
    expect(images).toHaveLength(1);
    expect(seen).toEqual([images[0].key]);

    // Directly too, so a future caller cannot forget the callback.
    const direct: string[] = [];
    await editWithGpt("edit again", TINY_PNG, "low", async (img) => {
      direct.push(img.key);
    });
    expect(direct).toHaveLength(1);
  });

  // saveRemoteVideo's stub branch used to key on the URL the PROVIDER supplied,
  // so a gateway answering a poll with "mock://x" made us store 10 bytes of junk
  // under a real key and the worker then charged the caller for a video.
  it("does not honour a provider-supplied mock:// URL when mocking is off", async () => {
    await expect(saveRemoteVideo("mock://video.mp4")).rejects.toThrow(/invalid-url-scheme/);
  });

  it("still stores the stub in mock mode", async () => {
    process.env.MOCK_IMAGE_PROVIDER = "1";
    const key = await saveRemoteVideo("mock://video.mp4");
    expect((await getStorage().get(key))?.toString()).toBe("mock-video");
  });
});
