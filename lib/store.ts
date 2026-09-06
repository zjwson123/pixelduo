import { isIP } from "net";
import { lookup as dnsLookup } from "dns/promises";
import { getStorage, newStorageKey } from "./storage";

export async function saveBase64Image(base64: string, ext = "png"): Promise<string> {
  const key = newStorageKey(ext);
  await getStorage().put(key, Buffer.from(base64, "base64"), `image/${ext}`);
  return key;
}

// ---- SSRF guard ----------------------------------------------------------
// The URL comes from a provider response, not user input, but a compromised
// provider must not be able to point us at internal services. Validate every
// hop: scheme, IP literal form (including decimal/hex/octal and IPv6-mapped
// spellings), and all DNS-resolved addresses. Residual risk: a TOCTOU DNS
// rebinding between our lookup and fetch's own resolution (pinning the
// connection to the resolved IP would require a custom agent).

function ipv4Private(v4: string): boolean {
  const o = v4.split(".").map(Number);
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b, c] = o;
  if (a === 0 || a === 10 || a === 127) return true; // this-network, private, loopback
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 192 && b === 0) return true; // protocol assignments + TEST-NET-1
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function split32(v: number): string {
  return [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].join(".");
}

// Decode inet_aton-style IPv4 literals the URL parser leaves untouched:
// "2130706433", "0x7f.1", "0177.0.0.1", "127.1" all resolve to loopback.
function decodeIpv4Literal(host: string): string | null {
  const parts = host.split(".");
  if (parts.length > 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    let v: number;
    if (/^0x[0-9a-f]+$/i.test(p)) v = parseInt(p.slice(2), 16);
    else if (/^0[0-7]+$/.test(p)) v = parseInt(p.slice(1), 8);
    else if (/^\d+$/.test(p)) v = parseInt(p, 10);
    else return null;
    if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) return null;
    nums.push(v);
  }
  // inet_aton: the last part may encode the remaining octets as one number.
  const last = nums[nums.length - 1];
  const head = nums.slice(0, -1);
  const rem = 4 - head.length;
  if (head.some((n) => n > 255)) return null;
  if (rem === 1) return last > 255 ? null : [...head, last].join(".");
  if (rem === 2) return last > 65535 ? null : [...head, (last >> 8) & 255, last & 255].join(".");
  if (rem === 3) return last > 0xffffff ? null : [...head, (last >> 16) & 255, (last >> 8) & 255, last & 255].join(".");
  return null;
}

function ipv6Private(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "::" || h === "::1") return true; // unspecified, loopback
  if (h.startsWith("::ffff:")) {
    // IPv4-mapped ::ffff:a.b.c.d (dotted or hex last two hextets)
    const v4 = h.slice(7);
    if (isIP(v4) === 4) return ipv4Private(v4);
    const m = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v4);
    if (m) return ipv4Private(split32((parseInt(m[1], 16) << 16) | parseInt(m[2], 16)));
    return true; // unparseable mapped form → treat as internal
  }
  if (/^f[cd]/.test(h)) return true; // fc00::/7 ULA
  if (/^fe[89ab]/.test(h)) return true; // fe80::/10 link-local
  if (h.startsWith("64:ff9b:")) return true; // NAT64 (embeds an IPv4)
  if (h.startsWith("2002:")) return true; // 6to4 (embeds an IPv4)
  // Embedded dotted quad ("::10.0.0.1", "64:ff9b::10.0.0.1")
  const dm = /(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  if (dm) return ipv4Private(dm[1]);
  return false;
}

async function hostIsPublic(hostname: string): Promise<boolean> {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return false;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return false;
  }
  const literal4 = decodeIpv4Literal(host);
  if (literal4) return !ipv4Private(literal4);
  if (isIP(host) === 6) return !ipv6Private(host);
  let addrs: { address: string }[];
  try {
    addrs = await dnsLookup(host, { all: true });
  } catch {
    return false; // unresolvable → fail closed
  }
  if (addrs.length === 0) return false;
  for (const { address } of addrs) {
    if (isIP(address) === 4 && ipv4Private(address)) return false;
    if (isIP(address) === 6 && ipv6Private(address)) return false;
  }
  return true;
}

export interface FetchPublicOptions {
  timeoutMs: number;
  maxBytes: number;
}

// Hardened download of a provider-returned URL, shared by the image and video
// paths: validates scheme and every DNS-resolved address, follows redirects
// manually so each hop is re-validated, and caps the response size.
export async function fetchPublicBuffer(rawUrl: string, opts: FetchPublicOptions): Promise<Buffer> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("invalid-url");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("invalid-url-scheme");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    let url = parsed;
    for (let hop = 0; hop < 6; hop++) {
      if (!(await hostIsPublic(url.hostname))) throw new Error("blocked-internal-url");
      const res = await fetch(url, { signal: controller.signal, redirect: "manual" });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) throw new Error(`download failed: ${res.status}`);
        try {
          url = new URL(loc, url);
        } catch {
          throw new Error("invalid-url");
        }
        if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("invalid-url-scheme");
        continue;
      }
      if (!res.ok) throw new Error(`download failed: ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > opts.maxBytes) throw new Error("download-too-large");
      return buf;
    }
    throw new Error("too-many-redirects");
  } finally {
    clearTimeout(timer);
  }
}

export async function saveRemoteImage(rawUrl: string): Promise<string> {
  // 25 MB cap so a huge provider response cannot exhaust memory.
  const buf = await fetchPublicBuffer(rawUrl, { timeoutMs: 30_000, maxBytes: 25 * 1024 * 1024 });
  const key = newStorageKey("png");
  await getStorage().put(key, buf, "image/png");
  return key;
}

export function serveUrl(key: string): Promise<string> {
  return getStorage().publicUrl(key);
}

// Same-origin, cookie-authenticated URL for browser <img>/download. Unlike
// S3 presigned URLs, this always resolves from the visitor's browser and is
// ownership-scoped by the /api/files route.
export function serveUserUrl(key: string): string {
  return `/api/files/${key}`;
}
