import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateImages } from "../lib/providers";
import { getStorage } from "../lib/storage";

// Resume-from-checkpoint (worker retries regenerate only missing images)
// relies on one contract: onImage fires after EACH image is already persisted
// to storage. Verify that ordering in mock mode — the real provider paths
// share the same call sites.
describe("image generation checkpointing", () => {
  beforeAll(() => {
    process.env.MOCK_IMAGE_PROVIDER = "1";
  });
  afterAll(() => {
    delete process.env.MOCK_IMAGE_PROVIDER;
  });

  it("fires onImage after each individual image is safely stored", async () => {
    const events: string[] = [];
    const images = await generateImages({
      model: "gpt",
      quality: "medium",
      count: 3,
      prompt: "checkpoint ordering test",
      onImage: async (img) => {
        // The checkpoint must never reference an image that isn't in storage
        // yet — a retry resuming from it would deliver a dead key.
        expect(await getStorage().get(img.key)).not.toBeNull();
        events.push(img.key);
      },
    });
    expect(images).toHaveLength(3);
    expect(events).toHaveLength(3);
    expect(new Set(events).size).toBe(3); // every image checkpointed exactly once
  });

  it("completes without a callback when none is given", async () => {
    const images = await generateImages({ model: "seedream", quality: "low", count: 2, prompt: "no callback" });
    expect(images).toHaveLength(2);
  });
});
