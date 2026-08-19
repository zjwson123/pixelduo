// Smart model router — uses a text model to analyze the prompt and recommend
// the best image generation model based on prompt characteristics.

import { getDeepSeekKey } from "./keys";
import { getImageModels, type ModelInfo } from "./model-registry";

export interface RoutingResult {
  recommendedModel: string;
  reason: string;
  offline: boolean;
}

const SYSTEM_PROMPT = `You are a model router for an AI image generation service. Given a user's prompt, analyze its characteristics and recommend the best model.

Available models:
- gpt: GPT Image 2. Best for: text rendering, logos, typography, fine detail, complex compositions. Slower (30-120s). Cost: 8 credits.
- seedream: Seedream 5. Best for: realistic photos, portraits, fast generation, real-world scenes. Fast (5-15s). Cost: 6 credits. Has built-in AI watermark.
- wan-image: Wan 2.7. Best for: quick drafts, budget-friendly, simple images. Fastest. Cost: 4 credits.
- wan-image-pro: Wan 2.7 Pro. Best for: 4K high resolution, group images, multi-image editing, complex instructions. Cost: 10 credits.

Rules:
- If prompt contains text, logos, or typography requests → recommend "gpt"
- If prompt requests realistic photos, portraits, or real-world scenes → recommend "seedream" or "wan-image-pro"
- If prompt is simple or budget-conscious → recommend "wan-image"
- If prompt requests 4K, multi-image, or editing → recommend "wan-image-pro"
- Default to "seedream" for general use

Reply with JSON only: {"model": "<model_id>", "reason": "<one sentence explanation>"}`;

export async function routePrompt(prompt: string): Promise<RoutingResult> {
  const key = getDeepSeekKey();
  if (!key) {
    return { recommendedModel: "seedream", reason: "offline default", offline: true };
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    let res: Response;
    try {
      res = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: "deepseek-v4-flash",
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: prompt },
          ],
          max_tokens: 100,
          temperature: 0.3,
          thinking: { type: "disabled" },
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (res.ok) {
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const text = data.choices?.[0]?.message?.content?.trim() ?? "";
      const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
      const start = cleaned.indexOf("{");
      const end = cleaned.lastIndexOf("}");
      if (start >= 0 && end > start) {
        const parsed = JSON.parse(cleaned.slice(start, end + 1)) as { model?: string; reason?: string };
        const validModels = getImageModels().map((m) => m.id);
        if (parsed.model && validModels.includes(parsed.model)) {
          return { recommendedModel: parsed.model, reason: parsed.reason ?? "smart routing", offline: false };
        }
      }
    }
  } catch {
    // fall through to offline
  }
  return { recommendedModel: "seedream", reason: "offline default", offline: true };
}
