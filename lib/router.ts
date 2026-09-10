// Smart model router — uses a text model to analyze the prompt and recommend
// the best image generation model based on prompt characteristics.

import { getDeepSeekKey, getDeepSeekBaseUrl } from "./keys";
import { getImageModels } from "./model-registry";
import { readJsonCapped } from "./store";

export interface RoutingResult {
  recommendedModel: string;
  reason: string;
  offline: boolean;
}

// Built from the enabled models in the registry so this prompt can never
// drift from what the UI/API actually offer.
function buildSystemPrompt(): string {
  const modelLines = getImageModels()
    .map((m) => `- ${m.id}: ${m.displayName}. ${m.description} Cost: ${m.costPerUnit.credits} credits.`)
    .join("\n");
  return `You are a model router for an AI image generation service. Given a user's prompt, analyze its characteristics and recommend the best model.

Available models:
${modelLines}

Rules:
- If prompt contains text, logos, or typography requests → recommend a model strong at text rendering
- If prompt requests realistic photos or portraits → recommend the realistic/fast model
- If prompt is simple or budget-conscious → recommend the cheapest model
- Default to the fast general-purpose model otherwise

Reply with JSON only: {"model": "<model_id>", "reason": "<one sentence explanation>"}`;
}

export async function routePrompt(prompt: string): Promise<RoutingResult> {
  const enabled = getImageModels();
  const offlineDefault = (): RoutingResult => ({
    // Seedream is the fast, mid-priced general default when it's available
    recommendedModel: enabled.some((m) => m.id === "seedream") ? "seedream" : enabled[0]?.id ?? "seedream",
    reason: "offline default",
    offline: true,
  });
  const key = getDeepSeekKey();
  if (!key) return offlineDefault();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    let res: Response;
    try {
      res = await fetch(`${getDeepSeekBaseUrl()}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: "deepseek-v4-flash",
          messages: [
            { role: "system", content: buildSystemPrompt() },
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
      const data = (await readJsonCapped(res, 8 * 1024 * 1024)) as unknown as { choices?: Array<{ message?: { content?: string } }> };
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
  return offlineDefault();
}
