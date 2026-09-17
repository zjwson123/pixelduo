import fs from "fs";
import os from "os";
import path from "path";

interface GatewayConfig {
  api_keys?: string[];
  base_url?: string;
  [k: string]: unknown;
}

interface CcProxyConfig {
  gateways?: Record<string, GatewayConfig>;
  vision_fallback?: { model?: string };
}

let cached: CcProxyConfig | null | undefined;

export function loadCcProxyConfig(): CcProxyConfig | null {
  if (cached !== undefined) return cached;  try {
    const p = path.join(os.homedir(), ".cc-proxy", "config.json");
    cached = JSON.parse(fs.readFileSync(p, "utf8")) as CcProxyConfig;
  } catch {
    cached = null;
  }
  return cached;
}

// Test hook: the config is read once per process, so a test that needs to
// simulate "no config resolves" (the fail-closed moderation path) must be able
// to drop the cached copy after pointing HOME somewhere empty.
export function _resetKeysCacheForTests(): void {
  cached = undefined;
}

function firstKey(gatewayName: string): string | undefined {
  const cfg = loadCcProxyConfig();
  const gw = cfg?.gateways?.[gatewayName];
  return gw?.api_keys?.find((k) => k.length > 0);
}

export function getModelVerseKey(): string | undefined {
  return process.env.MODELVERSE_IMAGE_API_KEY || firstKey("modelverse");
}

export function getArkKey(): string | undefined {
  return process.env.ARK_IMAGE_API_KEY || firstKey("ark");
}

export function getArkBaseUrl(): string {
  const cfg = loadCcProxyConfig();
  const gw = cfg?.gateways?.ark;
  if (gw?.base_url && gw.base_url.includes("images")) return gw.base_url;
  return "https://ark.cn-beijing.volces.com/api/v3/images/generations";
}

export function getAliyunKey(): string | undefined {
  return process.env.ALIYUN_API_KEY || process.env.DASHSCOPE_API_KEY || firstKey("aliyun");
}

export function getAliyunBaseUrl(service: "multimodal-generation" | "video-synthesis" | "text2image" = "multimodal-generation"): string {
  const cfg = loadCcProxyConfig();
  const gw = cfg?.gateways?.aliyun;
  if (gw?.base_url) {
    // base_url is like https://dashscope.aliyuncs.com/compatible-mode/v1
    // We need the base domain
    const baseUrl = gw.base_url.replace(/\/compatible-mode\/v1$/, "").replace(/\/v1$/, "");
    switch (service) {
      case "multimodal-generation":
        return `${baseUrl}/api/v1/services/aigc/multimodal-generation/generation`;
      case "video-synthesis":
        return `${baseUrl}/api/v1/services/aigc/video-generation/video-synthesis`;
      case "text2image":
        return `${baseUrl}/api/v1/services/aigc/text2image/image-synthesis`;
      default:
        return `${baseUrl}/api/v1/services/aigc/multimodal-generation/generation`;
    }
  }
  // Default DashScope endpoints
  const base = "https://dashscope.aliyuncs.com";
  switch (service) {
    case "multimodal-generation":
      return `${base}/api/v1/services/aigc/multimodal-generation/generation`;
    case "video-synthesis":
      return `${base}/api/v1/services/aigc/video-generation/video-synthesis`;
    case "text2image":
      return `${base}/api/v1/services/aigc/text2image/image-synthesis`;
    default:
      return `${base}/api/v1/services/aigc/multimodal-generation/generation`;
  }
}

// Key for the DeepSeek chat API (prompt assistant + smart routing).
// Priority: env var → a dedicated deepseek gateway in cc-proxy. The
// modelverse key is deliberately NOT used: it is not valid on
// api.deepseek.com, and modelverse delisted deepseek models anyway
// (probed 2026-08-22: "model [deepseek-v4-flash] is offline").
export function getDeepSeekKey(): string | undefined {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  const cfg = loadCcProxyConfig();
  for (const [name, gw] of Object.entries(cfg?.gateways ?? {})) {
    if (/deepseek|ds-/i.test(name)) {
      const k = gw.api_keys?.find((x) => x.length > 0);
      if (k) return k;
    }
  }
  return undefined;
}

// Chat-completions base for DeepSeek (no trailing slash, no path).
export function getDeepSeekBaseUrl(): string {
  const trim = (u: string) => u.replace(/\/+$/, "");
  if (process.env.DEEPSEEK_BASE_URL) return trim(process.env.DEEPSEEK_BASE_URL);
  const cfg = loadCcProxyConfig();
  for (const [name, gw] of Object.entries(cfg?.gateways ?? {})) {
    if (/deepseek|ds-/i.test(name) && gw.base_url) return trim(gw.base_url);
  }
  return "https://api.deepseek.com";
}

export interface VisionConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

// Vision-capable chat model for post-generation image moderation
export function getVisionConfig(): VisionConfig | null {
  const model = process.env.VISION_MODERATION_MODEL || "gpt-5.6-luna";
  // Empty string must mean "unset", the way it does for every other key in
  // this file. `"" ?? fallback` keeps the empty string (?? only falls back on
  // null/undefined), so a compose file that declares the variable with an empty
  // default — which is how .env.example and both prod composes ship it — made
  // getVisionConfig return null and turned the moderation audit into a silent
  // no-op that still reported itself as configured.
  const envKey = process.env.VISION_MODERATION_API_KEY || undefined;
  const envBase = process.env.VISION_MODERATION_BASE_URL || undefined;
  if (envKey && envBase) {
    return { baseUrl: envBase, apiKey: envKey, model };
  }
  const cfg = loadCcProxyConfig();
  const gw = cfg?.gateways?.modelverse;
  const apiKey = envKey ?? gw?.api_keys?.find((k) => k.length > 0);
  const baseUrl = envBase ?? gw?.base_url;
  if (!baseUrl || !apiKey) return null;
  const fallbackModel = (cfg?.vision_fallback as { model?: string } | undefined)?.model ?? "gpt-5.6-luna";
  return {
    baseUrl,
    apiKey,
    model: model || fallbackModel,
  };
}
