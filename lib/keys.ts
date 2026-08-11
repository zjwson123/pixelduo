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
  if (cached !== undefined) return cached;
  try {
    const p = path.join(os.homedir(), ".cc-proxy", "config.json");
    cached = JSON.parse(fs.readFileSync(p, "utf8")) as CcProxyConfig;
  } catch {
    cached = null;
  }
  return cached;
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

export function getDeepSeekKey(): string | undefined {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  const cfg = loadCcProxyConfig();
  const gws = cfg?.gateways ?? {};
  for (const [name, gw] of Object.entries(gws)) {
    if (/deepseek|ds-/i.test(name)) {
      const k = gw.api_keys?.find((x) => x.length > 0);
      if (k) return k;
    }
  }
  return undefined;
}

export interface VisionConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

// Vision-capable chat model for post-generation image moderation
// (cc-proxy modelverse gateway; model overridable via VISION_MODERATION_MODEL).
export function getVisionConfig(): VisionConfig | null {
  const model = process.env.VISION_MODERATION_MODEL || "gpt-5.4";
  const envKey = process.env.VISION_MODERATION_API_KEY;
  const envBase = process.env.VISION_MODERATION_BASE_URL;
  if (envKey && envBase) {
    return { baseUrl: envBase, apiKey: envKey, model };
  }
  const cfg = loadCcProxyConfig();
  const gw = cfg?.gateways?.modelverse;
  const apiKey = envKey ?? gw?.api_keys?.find((k) => k.length > 0);
  const baseUrl = envBase ?? gw?.base_url;
  if (!baseUrl || !apiKey) return null;
  const fallbackModel =
    (cfg?.vision_fallback as { model?: string } | undefined)?.model ?? "gpt-5.4";
  return {
    baseUrl,
    apiKey,
    model: model || fallbackModel,
  };
}
