import { getStorage } from "./storage";
import { getVisionConfig } from "./keys";
import { hostIsPublic } from "./store";

const BLOCKED: Array<{ re: RegExp; reason: string }> = [
  { re: /\b(sex|nude|naked|porn|erotic|nsfw|explicit)\b/i, reason: "adult-content" },
  { re: /(色情|裸露|裸体|成人内容)/, reason: "adult-content" },
  { re: /\b(gore|bloodbath|mutilation|torture)\b/i, reason: "violence" },
  { re: /(血腥|暴力|折磨|肢解)/, reason: "violence" },
  { re: /\b(child(ren)? (abuse|porn|sexual)|minor.*sexual)\b/i, reason: "child-safety" },
  { re: /(儿童.*(色情|性)|未成年.*色情)/, reason: "child-safety" },
  { re: /\b(weapon|bomb|explosive|assassination)\b/i, reason: "weapons" },
  { re: /(武器|炸弹|爆炸物|刺杀)/, reason: "weapons" },
];

export interface SafetyResult {
  ok: boolean;
  reason?: string;
}

export function checkPrompt(prompt: string): SafetyResult {
  for (const rule of BLOCKED) {
    if (rule.re.test(prompt)) {
      return { ok: false, reason: rule.reason };
    }
  }
  return { ok: true };
}

export interface ImageAudit {
  checked: boolean;
  flagged?: boolean;
  provider?: string;
}

// Robustly extract {flagged, reason} from a vision-model reply (may be fenced).
export function parseModerationJson(text: string): { flagged: boolean; reason?: string } | null {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const data = JSON.parse(cleaned.slice(start, end + 1)) as {
      flagged?: boolean;
      reason?: string;
    };
    if (typeof data.flagged !== "boolean") return null;
    return { flagged: data.flagged, reason: typeof data.reason === "string" ? data.reason : undefined };
  } catch {
    return null;
  }
}

const MODERATION_PROMPT = `You are a strict content moderator for an AI image service that only allows SFW content.
Inspect the image and reply with JSON only, no other text:
{"flagged": true, "reason": "<short reason>"} if the image contains nudity, sexual content, gore, extreme violence, weapon promotion, or content involving minors inappropriately.
Otherwise reply {"flagged": false}.
Be precise: ordinary photos of people, art, products, or mild action are fine.`;

async function moderateWithVision(dataUrl: string): Promise<ImageAudit> {
  const cfg = getVisionConfig();
  if (!cfg) return { checked: false };
  try {
    // Timeout after 30s so moderation cannot stall the worker pipeline.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    let res: Response;
    try {
      res = await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({
          model: cfg.model,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: MODERATION_PROMPT },
                { type: "image_url", image_url: { url: dataUrl } },
              ],
            },
          ],
          max_tokens: 120,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return { checked: false };
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = data.choices?.[0]?.message?.content;
    if (!text) return { checked: false };
    const parsed = parseModerationJson(text);
    if (!parsed) return { checked: false };
    return { checked: true, flagged: parsed.flagged, provider: `vision:${cfg.model}` };
  } catch {
    return { checked: false };
  }
}

// Post-generation safety audit:
// 1. IMAGE_NSFW_ENDPOINT (external HTTP detector) — legacy pluggable path.
// 2. IMAGE_MODERATION=1 — vision-model moderation via the cc-proxy gateway
//    (default gpt-5.4), reading the generated image from the storage driver.
// Without any of these the audit is skipped (checked: false).
async function isSafeEndpointUrl(rawUrl: string): Promise<boolean> {
  // Same canonical SSRF guard as fetchPublicBuffer (store.ts): hostname
  // literal decoding + full DNS resolution. The previous string-prefix
  // blocklist missed decimal/hex IPv4 forms and rebinding hostnames, and the
  // fetch followed redirects without re-validation.
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    return await hostIsPublic(parsed.hostname);
  } catch {
    return false;
  }
}

export async function analyzeImage(url: string): Promise<ImageAudit> {
  const endpoint = process.env.IMAGE_NSFW_ENDPOINT;
  if (endpoint) {
    // SSRF guard: only allow public http(s) endpoints for the external detector.
    if (!(await isSafeEndpointUrl(endpoint))) return { checked: false };
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);
      let res: Response;
      try {
        res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url }),
          signal: controller.signal,
          redirect: "manual", // a detector endpoint has no business redirecting
        });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) return { checked: false };
      const data = (await res.json()) as { flagged?: boolean };
      return { checked: true, flagged: Boolean(data.flagged), provider: "external" };
    } catch {
      return { checked: false };
    }
  }
  if (process.env.IMAGE_MODERATION === "1") {
    try {
      const buf = await getStorage().get(url);
      if (!buf) return { checked: false };
      const ext = url.endsWith(".jpg") || url.endsWith(".jpeg") ? "jpeg" : "png";
      const dataUrl = `data:image/${ext};base64,${buf.toString("base64")}`;
      return moderateWithVision(dataUrl);
    } catch {
      return { checked: false };
    }
  }
  return { checked: false };
}
