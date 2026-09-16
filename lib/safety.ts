import sharp from "sharp";
import { getStorage } from "./storage";
import { getVisionConfig } from "./keys";
import { hostIsPublic, isPublicPort, readJsonCapped, ssrfPinnedAgent, outboundTimeoutMs } from "./store";
import { fetch as pinnedFetch } from "undici";

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
  // Moderation is CONFIGURED, but this image could not actually be audited
  // (detector error/timeout, unparseable reply, object missing, no vision
  // config resolved). Deliberately distinct from `checked: false` alone, which
  // also covers "moderation is off by design": the worker must not deliver
  // output it could not audit when the operator asked for an audit, but must
  // keep working when they did not.
  unavailable?: boolean;
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
    const timer = setTimeout(() => controller.abort(), outboundTimeoutMs(30_000));
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
      // Read the body while the timer is still armed: clearing it as soon as
      // the headers land leaves the stream unbounded (see callWithKeys).
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        return { checked: false, unavailable: true };
      }
      const data = (await readJsonCapped(res, 8 * 1024 * 1024)) as unknown as { choices?: Array<{ message?: { content?: string } }> };
      const text = data.choices?.[0]?.message?.content;
      if (!text) return { checked: false, unavailable: true };
      const parsed = parseModerationJson(text);
      if (!parsed) return { checked: false, unavailable: true };
      return { checked: true, flagged: parsed.flagged, provider: `vision:${cfg.model}` };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return { checked: false, unavailable: true };
  }
}

// Largest object worth base64-encoding and stringifying into the audit request
// (peak cost per image is ~2.4x the file size).
const MODERATION_MAX_IMAGE_BYTES = 8 * 1024 * 1024;
// Above this, an output is downscaled before the audit instead of being skipped.
const MODERATION_DOWNSCALE_ABOVE_BYTES = 1024 * 1024;
const MODERATION_EDGE = 1024;

// Shrink an oversized output so it can still be audited. Skipping anything past
// the audit budget was a DETERMINISTIC moderation bypass: the encoded size is
// chosen by the provider, not by us, so a fine-detail prompt at
// size "1920x1920" (~11 MB as PNG) produced an output that was never moderated
// while the job reported success and was billed. Downscaling to a reviewable
// edge keeps every output inside the auditable range.
async function shrinkForAudit(buf: Buffer): Promise<Buffer> {
  return sharp(buf, { limitInputPixels: 100_000_000 })
    .resize({ width: MODERATION_EDGE, height: MODERATION_EDGE, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer();
}

// Post-generation safety audit:
// 1. IMAGE_NSFW_ENDPOINT (external HTTP detector) — legacy pluggable path.
// 2. IMAGE_MODERATION=1 — vision-model moderation via the cc-proxy gateway
//    (default gpt-5.4), reading the generated image from the storage driver.
// Without any of these the audit is skipped (checked: false).
async function isSafeEndpointUrl(rawUrl: string): Promise<boolean> {
  // Same canonical SSRF guard as fetchPublicBuffer (store.ts): hostname
  // literal decoding + full DNS resolution + port allowlist. The previous
  // string-prefix blocklist missed decimal/hex IPv4 forms and rebinding
  // hostnames, and the fetch followed redirects without re-validation.
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    if (!isPublicPort(parsed.port)) return false;
    return await hostIsPublic(parsed.hostname);
  } catch {
    return false;
  }
}

export async function analyzeImage(url: string): Promise<ImageAudit> {
  const endpoint = process.env.IMAGE_NSFW_ENDPOINT;
  if (endpoint) {
    // SSRF guard: only allow public http(s) endpoints for the external detector.
    if (!(await isSafeEndpointUrl(endpoint))) return { checked: false, unavailable: true };
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), outboundTimeoutMs(30_000));
      try {
        const res = (await pinnedFetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url }),
          signal: controller.signal,
          redirect: "manual", // a detector endpoint has no business redirecting
          // Same DNS-pinned agent as fetchPublicBuffer: hostIsPublic above
          // validates at check time, and the agent re-validates at connect
          // time, so a rebinding answer between the two cannot reach an
          // internal address. The global fetch would have used the default
          // dispatcher and reopened that TOCTOU window.
          dispatcher: ssrfPinnedAgent,
        })) as unknown as Response;
        if (!res.ok) {
          await res.body?.cancel().catch(() => undefined);
          return { checked: false, unavailable: true };
        }
        const data = (await readJsonCapped(res, 8 * 1024 * 1024)) as unknown as { flagged?: boolean };
        return { checked: true, flagged: Boolean(data.flagged), provider: "external" };
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return { checked: false, unavailable: true };
    }
  }
  if (process.env.IMAGE_MODERATION === "1") {
    try {
      const buf = await getStorage().get(url);
      if (!buf) return { checked: false, unavailable: true };
      let payload = buf;
      let ext = url.endsWith(".jpg") || url.endsWith(".jpeg") ? "jpeg" : "png";
      if (buf.length > MODERATION_DOWNSCALE_ABOVE_BYTES) {
        // Downscale rather than skip — see shrinkForAudit. If even that fails
        // (corrupt or unsupported object) we have nothing auditable, and an
        // unauditable output must not be delivered; the worker turns this into
        // a refunded failure.
        try {
          payload = await shrinkForAudit(buf);
          ext = "jpeg";
        } catch {
          return { checked: false, unavailable: true };
        }
      }
      if (payload.length > MODERATION_MAX_IMAGE_BYTES) return { checked: false, unavailable: true };
      const dataUrl = `data:image/${ext};base64,${payload.toString("base64")}`;
      return moderateWithVision(dataUrl);
    } catch {
      return { checked: false, unavailable: true };
    }
  }
  return { checked: false };
}

// Audit a batch of images ONE AT A TIME. The caller used Promise.all over a
// batch of up to 8 images; with the in-process vision path each concurrent
// audit holds the object buffer, its base64 data URL and the stringified
// request body simultaneously — a worst case near 1 GB in a single worker
// container, which OOMs and strands in-flight jobs (which retry and re-bill).
export async function analyzeAllImagesSequentially(urls: string[]): Promise<ImageAudit[]> {
  const out: ImageAudit[] = [];
  for (const url of urls) {
    out.push(await analyzeImage(url));
  }
  return out;
}
