// Smart model router — uses a text model to analyze the prompt and recommend
// the best image generation model based on prompt characteristics.

import { getDeepSeekKey, getDeepSeekBaseUrl } from "./keys";
import { getImageModels } from "./model-registry";
import { readJsonCapped, outboundTimeoutMs } from "./store";

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
    const timer = setTimeout(() => controller.abort(), outboundTimeoutMs(15_000));
    let res: Response;
    try {
      res = await fetch(`${getDeepSeekBaseUrl()}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: "deepseek-flash",
          messages: [
            { role: "system", content: buildSystemPrompt() },
            { role: "user", content: prompt },
          ],
          max_tokens: 100,
          temperature: 0.3,
          thinking: { type: "disabled" },
        }),
        signal: controller.signal,
        // No redirects — see callWithKeys in providers/index.ts. A gateway that
        // answers 307 would otherwise pick the address this request (and its
        // Authorization header) is re-sent to.
        redirect: "manual",
      });
      // The body read stays inside the armed-timer window: clearing the
      // timeout as soon as the headers arrive leaves the stream unbounded
      // (undici's bodyTimeout is an idle timer that every chunk resets).
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
            // Bounded like every other provider-supplied string that reaches a
            // client (see errText in providers/index.ts): the gateway can return
            // up to the 8 MB body cap here, and an unbounded `reason` would be
            // relayed straight to the workbench.
            const reason =
              typeof parsed.reason === "string" && parsed.reason ? parsed.reason.slice(0, 240) : "smart routing";
            return { recommendedModel: parsed.model, reason, offline: false };
          }
        }
      } else {
        // A non-2xx reply's body was never read or cancelled, which keeps its
        // socket out of the pool until GC. Under provider errors this path is
        // hit for every request.
        await res.body?.cancel().catch(() => undefined);
      }
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // fall through to offline
  }
  return offlineDefault();
}
