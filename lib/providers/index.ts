import { getModelVerseKey, getArkKey, getArkBaseUrl } from "../keys";
import { saveBase64Image } from "../store";
import type { Quality, ModelId } from "../cost";

export interface ProviderImage {
  key: string;
  model: "gpt" | "seedream";
}

async function callWithKeys(url: string, body: Record<string, unknown>, keys: string[]) {
  let lastErr: unknown;
  for (const key of keys) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
      });
      if (res.ok) return (await res.json()) as Record<string, unknown>;
      const text = await res.text();
      const err = new Error(`${res.status}: ${text.slice(0, 240)}`);
      if (res.status === 401 || res.status === 403) {
        lastErr = err;
        continue;
      }
      throw err;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("provider call failed");
}

export async function generateWithGpt(prompt: string, quality: Quality, count: number): Promise<ProviderImage[]> {
  const keys = [getModelVerseKey()].filter((k): k is string => Boolean(k));
  if (!keys.length) throw new Error("modelverse key missing — set MODELVERSE_IMAGE_API_KEY or ensure ~/.cc-proxy/config.json has modelverse gateway");
  const out: ProviderImage[] = [];
  for (let i = 0; i < count; i++) {
    const data = await callWithKeys(
      "https://api.modelverse.cn/v1/images/generations",
      { model: "gpt-image-2", prompt, size: "1024x1024", quality, n: 1 },
      keys,
    );
    const items = (data.data as Array<Record<string, unknown>> | undefined) ?? [];
    const b64 = items[0]?.b64_json as string | undefined;
    if (!b64) throw new Error("gpt-image-2 returned no b64_json");
    out.push({ key: await saveBase64Image(b64), model: "gpt" });
  }
  return out;
}

export async function generateWithSeedream(prompt: string, count: number): Promise<ProviderImage[]> {
  const keys = [getArkKey()].filter((k): k is string => Boolean(k));
  if (!keys.length) throw new Error("ark key missing — set ARK_IMAGE_API_KEY or ensure ~/.cc-proxy/config.json has ark gateway");
  const out: ProviderImage[] = [];
  for (let i = 0; i < count; i++) {
    const data = await callWithKeys(
      getArkBaseUrl(),
      { model: "doubao-seedream-5-0-260128", prompt, size: "1920x1920", response_format: "b64_json", n: 1 },
      keys,
    );
    const items = (data.data as Array<Record<string, unknown>> | undefined) ?? [];
    const b64 = items[0]?.b64_json as string | undefined;
    if (!b64) throw new Error("seedream returned no b64_json");
    out.push({ key: await saveBase64Image(b64), model: "seedream" });
  }
  return out;
}

export async function generateImages(input: {
  model: ModelId;
  quality: Quality;
  count: number;
  prompt: string;
}): Promise<ProviderImage[]> {
  // Mock mode for tests / demos: instant 1x1 PNGs, no external calls.
  if (process.env.MOCK_IMAGE_PROVIDER === "1") {
    const tinyPng =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const out: ProviderImage[] = [];
    const list: Array<"gpt" | "seedream"> =
      input.model === "both" ? (["gpt", "seedream"] as const) : input.model === "seedream" ? ["seedream"] : ["gpt"];
    for (let i = 0; i < input.count; i++) {
      for (const m of list) out.push({ key: await saveBase64Image(tinyPng), model: m });
    }
    return out;
  }
  if (input.model === "both") {
    const [gpt, seed] = await Promise.all([
      generateWithGpt(input.prompt, input.quality, input.count),
      generateWithSeedream(input.prompt, input.count),
    ]);
    return [...gpt, ...seed];
  }
  if (input.model === "seedream") return generateWithSeedream(input.prompt, input.count);
  return generateWithGpt(input.prompt, input.quality, input.count);
}
