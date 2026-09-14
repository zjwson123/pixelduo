import { isIP } from "net";
import { lookup as dnsLookup } from "dns/promises";
import { lookup as dnsLookupCb, type LookupAddress, type LookupOptions } from "dns";
import { Agent, fetch as pinnedFetch } from "undici";
import { getStorage, newStorageKey } from "./storage";

export async function saveBase64Image(base64: string, ext = "png"): Promise<string> {
  // Reject before decoding: a hostile provider response must not allocate a
  // decoded buffer before any cap exists. 40 MB of base64 ≈ 30 MB decoded —
  // comfortably above any real image, below memory-exhaustion territory.
  if (base64.length > 40 * 1024 * 1024) throw new Error("image-too-large");
  const key = newStorageKey(ext);
  await getStorage().put(key, Buffer.from(base64, "base64"), `image/${ext}`);
  return key;
}

// Read a response body, aborting the moment the running total exceeds
// maxBytes. Buffering via res.arrayBuffer()/res.text() would download the
// complete body first — the cap would only fire after the heap spike it is
// meant to prevent.
export async function readBodyCapped(res: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("download-too-large");
  if (!res.body) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new Error("download-too-large");
    return buf;
  }
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error("download-too-large");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

// Parse a JSON response body with the same streaming cap — for outbound calls
// to operator-configured LLM/moderation endpoints (a hostile or compromised
// gateway must not be able to OOM the process with an unbounded body).
export async function readJsonCapped(res: Response, maxBytes: number): Promise<Record<string, unknown>> {
  return JSON.parse((await readBodyCapped(res, maxBytes)).toString("utf8")) as Record<string, unknown>;
}

// ---- SSRF guard ----------------------------------------------------------
// The URL comes from a provider response, not user input, but a compromised
// provider must not be able to point us at internal services. Validate every
// hop: scheme, port, IP literal form (including decimal/hex/octal and
// IPv6-mapped spellings), and all DNS-resolved addresses. The fetch itself
// runs on a pinned undici Agent whose custom lookup re-validates every
// address at CONNECT time — closing the DNS-rebinding TOCTOU where a
// TTL≈0 name resolves public for our check and internal for fetch's own
// resolution (validation and connect now share one lookup).

// Custom connect-time lookup: resolve, drop private-range addresses, and
// fail closed when every address is internal.
//
// The caller decides the callback ARITY: net.connect passes { all: true }
// whenever autoSelectFamily is enabled (the default since Node 20) and then
// requires an ARRAY of { address, family }. Answering with a single string
// makes net build "undefined" as the address, so the connection dies with
// ERR_INVALID_IP_ADDRESS before a socket exists — i.e. the guard silently
// blocks every download it is meant to allow. Honouring opts.all is what
// keeps the pinned agent usable at all.
export function createPublicOnlyLookup(
  isBlocked: (address: string) => boolean = isPrivateAddress,
) {
  return (
    host: string,
    opts: LookupOptions,
    cb: (
      err: NodeJS.ErrnoException | null,
      address: string | LookupAddress[],
      family?: number,
    ) => void,
  ) => {
    dnsLookupCb(host, { ...opts, all: true }, (err, addrs: LookupAddress[] | LookupAddress) => {
      if (err) return cb(err, "");
      const list: LookupAddress[] = Array.isArray(addrs) ? addrs : [addrs];
      const safe = list.filter((a) => isIP(a.address) !== 0 && !isBlocked(a.address));
      if (safe.length === 0) {
        const blocked = new Error("blocked-internal-address") as NodeJS.ErrnoException;
        blocked.code = "EACCES";
        return cb(blocked, "", 4);
      }
      if (opts.all) return cb(null, safe, undefined);
      cb(null, safe[0].address, safe[0].family ?? (isIP(safe[0].address) === 6 ? 6 : 4));
    });
  };
}

function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) return ipv4Private(address);
  if (isIP(address) === 6) return ipv6Private(address);
  return true; // not an IP literal → refuse
}

const ssrfPinnedAgent = new Agent({
  connect: { lookup: createPublicOnlyLookup() },
});

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
  if (/^fe[c-f]/.test(h)) return true; // fec0::/10 site-local (deprecated, still routable)
  if (/^ff/.test(h)) return true; // ff00::/8 multicast
  if (h.startsWith("2001:db8")) return true; // 2001:db8::/32 documentation
  if (h.startsWith("2001:0:") || h.startsWith("2001:0000")) return true; // 2001::/32 Teredo
  if (h.startsWith("100::")) return true; // 100::/64 discard-only
  if (h.startsWith("64:ff9b:")) return true; // NAT64 (embeds an IPv4)
  if (h.startsWith("2002:")) return true; // 6to4 (embeds an IPv4)
  // Embedded dotted quad ("::10.0.0.1", "64:ff9b::10.0.0.1")
  const dm = /(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  if (dm) return ipv4Private(dm[1]);
  return false;
}

// Canonical SSRF host check (shared by fetchPublicBuffer and any other
// outbound fetch of a configurable URL): hostname string checks, inet_aton
// literal decoding, IPv6 forms, and full DNS resolution.
export async function hostIsPublic(hostname: string): Promise<boolean> {
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
      // Ports are part of the SSRF surface too: without this a "public" host
      // could be probed on internal-ish services (redis :6379, ssh :22 …).
      if (url.port !== "" && url.port !== "80" && url.port !== "443") {
        throw new Error("blocked-port");
      }
      // Pinned agent: even if DNS rebinds between the check above and the
      // TCP connect, the connect itself refuses non-public addresses.
      const res = (await pinnedFetch(url, {
        signal: controller.signal,
        redirect: "manual",
        dispatcher: ssrfPinnedAgent,
      })) as unknown as Response;
      if (res.status >= 300 && res.status < 400) {
        // Release the connection instead of leaving the 3xx body pinned
        // until GC (up to 6 hops per download).
        await res.body?.cancel().catch(() => undefined);
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
      return await readBodyCapped(res, opts.maxBytes);
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
