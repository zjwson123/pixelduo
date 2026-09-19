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

// Ark (Volcengine) image edits. The credential may come from env or from the
// cc-proxy "ark" gateway, while the endpoint can ONLY come from that same
// operator-owned gateway — and only when it looks like an image endpoint; the
// gateway's usual base_url is Ark's /api/coding/v1 (a chat endpoint), which is
// why that gate exists. There is no cross-vendor pairing to fix here the way
// there was for vision (where a name-matching heuristic picked the key up from
// a DIFFERENT vendor's gateway): both halves are the operator's own Ark
// configuration, and the fallback below is Ark's own host.
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
//
// Credential and endpoint are resolved as ONE pair, from ONE source. Reading
// them independently — the key from the first name-matching gateway that has a
// key, the base URL from the first that has a base_url, or an env override on
// only one side — pairs halves that were never meant to travel together:
// DEEPSEEK_BASE_URL=https://relay.partner.example/v1 (documented in
// .env.example) with the key coming from ~/.cc-proxy/config.json, or two
// differently-named deepseek gateways each supplying half, sends a live
// credential to a host chosen by the other source. This is the same rule
// getVisionConfig below enforces, and the same failure it was written for.
function deepSeekSource(): { key: string; baseUrl: string } | null {
  const trim = (u: string) => u.replace(/\/+$/, "");
  const envKey = process.env.DEEPSEEK_API_KEY || undefined;
  const envBase = process.env.DEEPSEEK_BASE_URL || undefined;
  if (envKey || envBase) {
    // Atomic, the way every other pair in this file is: a partial override is
    // a misconfiguration, not an invitation to borrow the missing half.
    if (envKey && envBase) return { key: envKey, baseUrl: trim(envBase) };
    return null;
  }
  const cfg = loadCcProxyConfig();
  for (const [name, gw] of Object.entries(cfg?.gateways ?? {})) {
    if (!/deepseek|ds-/i.test(name)) continue;
    const key = gw.api_keys?.find((k) => k.length > 0);
    if (!key) continue;
    // The same gateway supplies the endpoint when it declares one; otherwise
    // the vendor default, which is still DeepSeek's own host.
    return { key, baseUrl: gw.base_url ? trim(gw.base_url) : "https://api.deepseek.com" };
  }
  return null;
}

export function getDeepSeekKey(): string | undefined {
  return deepSeekSource()?.key;
}

// Chat-completions base for DeepSeek (no trailing slash, no path).
export function getDeepSeekBaseUrl(): string {
  return deepSeekSource()?.baseUrl ?? "https://api.deepseek.com";
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
  // The env pair is ATOMIC: half of it must never be paired with half of the
  // cc-proxy config. Doing that sent one gateway's credential to another
  // host — with only VISION_MODERATION_BASE_URL set, the ModelVerse API key
  // from ~/.cc-proxy/config.json was handed to that third-party host; with only
  // VISION_MODERATION_API_KEY set (and a modelverse gateway present, which is
  // the documented dev setup), the operator's moderation key was sent to
  // api.modelverse.cn. A partial override is a misconfiguration, not a request
  // to mix sources: return null so the worker's boot gate reports it.
  if (envKey || envBase) {
    if (envKey && envBase) return { baseUrl: envBase, apiKey: envKey, model };
    return null;
  }
  const cfg = loadCcProxyConfig();
  const gw = cfg?.gateways?.modelverse;
  const apiKey = gw?.api_keys?.find((k) => k.length > 0);
  const baseUrl = gw?.base_url;
  if (!baseUrl || !apiKey) return null;
  const fallbackModel = (cfg?.vision_fallback as { model?: string } | undefined)?.model ?? "gpt-5.6-luna";
  return {
    baseUrl,
    apiKey,
    model: model || fallbackModel,
  };
}
