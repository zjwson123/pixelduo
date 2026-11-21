import { isIP } from "net";
import { lookup as dnsLookup } from "dns/promises";
import { lookup as dnsLookupCb, type LookupAddress, type LookupOptions } from "dns";
import { Agent, fetch as pinnedFetch } from "undici";
import { getStorage, newStorageKey } from "./storage";
// Re-exported for the provider call sites; the deadline helper lives in
// lib/runtime-env.ts so lib/storage.ts can use it without a cycle.
export { outboundTimeoutMs } from "./runtime-env";
import { storeContentType, extensionForContentType, sniffContentType, type MediaKind } from "./media-type";

export async function saveBase64Image(base64: string, ext = "png"): Promise<string> {
  // Reject before decoding: a hostile provider response must not allocate a
  // decoded buffer before any cap exists. 40 MB of base64 ≈ 30 MB decoded —
  // comfortably above any real image, below memory-exhaustion territory.
  if (base64.length > 40 * 1024 * 1024) throw new Error("image-too-large");
  const buf = Buffer.from(base64, "base64");
  // A base64 string that decodes to NOTHING is not an image (pass 66). The
  // edit route's zod guard only checks the string's LENGTH, so `"!".repeat(100)`
  // — which Buffer.from stops decoding at the first invalid byte — stored a
  // zero-byte object; the worker's `if (!refBuf)` is false for an empty Buffer,
  // imageBase64 became "", and generateImages' `if (input.imageBase64)` fell
  // through to plain text-to-image. The caller paid the edit price for a
  // generation, and the job "succeeded". Refuse at the one place every
  // base64-to-object path goes through.
  if (buf.length === 0) throw new Error("empty-image: the supplied image decoded to zero bytes");
  // Same rule as saveRemoteImage: the bytes decide what this object is, the
  // caller's expectation is only the fallback for a format we do not sniff.
  const sniffed = sniffContentType(buf);
  const key = newStorageKey(sniffed ? extensionForContentType(sniffed) : ext);
  await getStorage().put(key, buf, sniffed ?? (`image/${ext}` as MediaKind));
  return key;
}

// Read a response body, aborting the moment the running total exceeds
// maxBytes. Buffering via res.arrayBuffer()/res.text() would download the
// complete body first — the cap would only fire after the heap spike it is
// meant to prevent.
export async function readBodyCapped(res: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    // The streaming branch below cancels on the same refusal, and the 3xx/4xx
    // branches of fetchPublicBuffer cancel explicitly: an undici response whose
    // body is never read keeps its socket out of the pool until GC, so a
    // hostile declared length would pin a connection per job in the worker's
    // single tick loop.
    await res.body?.cancel().catch(() => undefined);
    throw new Error("download-too-large");
  }
  if (!res.body) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new Error("download-too-large");
    return buf;
  }
  const reader = res.body.getReader();
  // One growable buffer, not one Buffer per chunk (pass 66). The byte cap
  // bounded the payload but not the object count: a provider answering a poll
  // or an artifact download with one-byte chunks made the worker retain one
  // Buffer per byte (the 1 MiB poll cap is ~1M objects, the 100 MB video cap is
  // far worse) and die of heap exhaustion before the cap could fire. A hostile
  // or compromised gateway controls the chunking, so this is its cheapest way
  // to OOM the worker. Growth is geometric, bounded by maxBytes, and each chunk
  // is copied in once.
  let buf = Buffer.allocUnsafe(Math.max(1, Math.min(maxBytes, 64 * 1024)));
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const n = value.byteLength;
    if (size + n > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error("download-too-large");
    }
    if (size + n > buf.length) {
      let capacity = buf.length;
      while (capacity < size + n) capacity = Math.min(maxBytes, capacity * 2);
      const grown = Buffer.allocUnsafe(capacity);
      buf.copy(grown, 0, 0, size);
      buf = grown;
    }
    buf.set(value, size);
    size += n;
  }
  return buf.subarray(0, size);
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

// The pinned agent is the CONNECT-time half of the SSRF defence, and undici's
// `lookup` hook never runs for an IP literal: net.connect has no name to
// resolve, so `http://127.0.0.1:9000/`, `http://[::1]/` — and the inet_aton
// spellings the URL parser normalises — all dial loopback with the lookup
// bypassed. Every current call site checks hostIsPublic first, so nothing was
// reachable; the problem was that the guard is DOCUMENTED as the backstop a
// future call site may lean on ("even if DNS rebinds between the check above and
// the TCP connect, the connect itself refuses non-public addresses") and for
// literals it silently was not. Dispatch is where the origin is still known, so
// the literal case is refused there and the claim becomes true.
class PublicOnlyAgent extends Agent {
  constructor() {
    // The name-resolving half (passes 6/8: validation and connect share one
    // lookup, so a rebinding between the two cannot land).
    super({ connect: { lookup: createPublicOnlyLookup() } });
  }

  dispatch(
    opts: Parameters<Agent["dispatch"]>[0],
    handler: Parameters<Agent["dispatch"]>[1],
  ): boolean {
    const host = literalHostname(opts.origin);
    if (host && isPrivateAddress(host)) {
      // The same signalling DispatcherBase.dispatch uses when the inner dispatch
      // throws (dispatcher-base.js: `handler.onResponseError(null, err); return
      // false`): hand the error to the handler and report "not dispatched". The
      // null is deliberate — that is what undici itself passes there.
      handler.onResponseError?.(null as never, new Error("blocked-internal-address"));
      return false;
    }
    return super.dispatch(opts, handler);
  }
}

export const ssrfPinnedAgent = new PublicOnlyAgent();

/** The hostname of an origin, unwrapped, when it is an IP literal — else null. */
export function literalHostname(origin: string | URL | undefined): string | null {
  if (!origin) return null;
  try {
    const host = new URL(String(origin)).hostname.replace(/^\[|\]$/g, "");
    return isIP(host) !== 0 ? host : null;
  } catch {
    return null;
  }
}

// Ports permitted for any outbound fetch of a URL we do not control. Without
// this a "public" host could still be probed on internal-ish services
// (redis :6379, ssh :22, …). Shared with lib/safety.ts's detector endpoint so
// the two paths cannot drift apart.
export function isPublicPort(port: string): boolean {
  return port === "" || port === "80" || port === "443";
}

function ipv4Private(v4: string): boolean {
  const o = v4.split(".").map(Number);
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b, c] = o;
  if (a === 0 || a === 10 || a === 127) return true; // this-network, private, loopback
  if (a === 169 && b === 254) return true; // link-local
  // Azure's WireServer/IMDS front end (pass 62). It is a host-internal service
  // that answers on port 80, and it is not inside any blocklisted range: a
  // compromised provider/gateway returning it as an artifact URL made
  // saveRemoteVideo fetch guest-agent metadata and store it as the owner's
  // "video". Other clouds' metadata addresses fall in ranges already refused
  // (169.254/16, 100.64/10); this is the one that does not.
  if (a === 168 && b === 63 && c === 129 && o[3] === 16) return true;
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
// Exported so a test can pin the forms directly; through hostIsPublic they are
// indistinguishable from "the hostname did not resolve".
export function decodeIpv4Literal(host: string): string | null {
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
  // A single part IS the whole address: "2130706433" and "0x7f000001" are
  // loopback. This case was missing (rem is 4 with one part, so every branch
  // below fell through to null), which contradicted the docstring and made the
  // decoder a no-op for the commonest form. Not exploitable while every caller
  // passes url.hostname — WHATWG normalises a pure-numeric host to dotted-quad
  // before we see it — but the guard was relying on that, and it is exactly the
  // kind of reliance the DNS fallback exists to stop relying on.
  if (rem === 4) return split32(last);
  if (rem === 1) return last > 255 ? null : [...head, last].join(".");
  if (rem === 2) return last > 65535 ? null : [...head, (last >> 8) & 255, last & 255].join(".");
  if (rem === 3) return last > 0xffffff ? null : [...head, (last >> 16) & 255, (last >> 8) & 255, last & 255].join(".");
  return null;
}

// Parse an IPv6 address into its eight 16-bit groups. Returns null on anything
// that is not a plain colon-separated address (an embedded dotted quad is
// handled before this by ipv6Private, whose callers still expect the mapped
// forms to answer "internal").
function parseIpv6(host: string): number[] | null {
  const parts = host.split("::");
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(":") : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(":") : [];
  for (const g of [...head, ...tail]) if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
  if (parts.length === 1) return head.length === 8 ? head.map((g) => parseInt(g, 16)) : null;
  if (head.length + tail.length > 7) return null;
  const zeros = Array<string>(8 - head.length - tail.length).fill("0");
  return [...head, ...zeros, ...tail].map((g) => parseInt(g, 16));
}

function ipv6Private(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  // Embedded dotted quad ("::10.0.0.1", "64:ff9b::10.0.0.1", and the mapped
  // "::ffff:127.0.0.1") first: parseIpv6 cannot read those groups.
  const dm = /(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  if (dm) return ipv4Private(dm[1]);
  // Numeric classification of the FULL address, not a string prefix. The old
  // prefix tests only recognised the compressed spellings, so the fully
  // expanded IPv4-mapped form — "0:0:0:0:0:ffff:7f00:1" is 127.0.0.1 — and
  // "0:0:0:0:0:0:0:1" came back PUBLIC from a predicate whose whole job is to
  // answer "may we dial this" (pass 51). Every caller passes a WHATWG-normalised
  // hostname today, which hides it; the connect-time agent reuses this function
  // precisely because string reliance was the thing that failed before.
  const g = parseIpv6(h);
  if (!g) return true; // unparseable → treat as internal
  const [a, b, c, d, e, f, hi, lo] = g;
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0 && hi === 0 && lo === 0) return true; // ::
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0 && hi === 0 && lo === 1) return true; // ::1
  // IPv4-mapped ::ffff:0:0/96 (hex last two hextets; the dotted form returned
  // above).
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0xffff) {
    return ipv4Private(split32(((hi << 16) | lo) >>> 0));
  }
  // IPv4-COMPATIBLE ::/96 ("::7f00:1", "::a9fe:a9fe" — cloud metadata).
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0) {
    return ipv4Private(split32(((hi << 16) | lo) >>> 0));
  }
  // Deprecated IPv4-TRANSLATED ::ffff:0:0:0/96 (RFC 2765): `::ffff:0:a9fe:a9fe`
  // is 169.254.169.254 embedded after the 0xffff marker. The mapped branch
  // above only matches the [0,0,0,0,0,ffff,hi,lo] spelling, so WHATWG's
  // normalisation of `[::ffff:0:169.254.169.254]` came back PUBLIC (pass 62).
  // Any host with a SIIT/NAT46 mapper would dial the embedded address.
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0xffff && f === 0) {
    return ipv4Private(split32(((hi << 16) | lo) >>> 0));
  }
  if ((a & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
  if ((a & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((a & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((a & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (a === 0x2001 && b === 0x0db8) return true; // 2001:db8::/32 documentation
  if (a === 0x2001 && b === 0x0000) return true; // 2001::/32 Teredo
  if (a === 0x0100 && b === 0 && c === 0 && d === 0) return true; // 100::/64 discard-only
  // The whole 64:ff9b::/32 translation space, not just the well-known
  // 64:ff9b::/96 (pass 61). RFC 8215's LOCAL-USE prefix is 64:ff9b:1::/48 —
  // its third hextet is 1, so the old exact /96 test answered PUBLIC and let a
  // compromised provider point the worker at an internal IPv4 through the
  // host's NAT64 translator (`64:ff9b:1::a9fe:a9fe` = 169.254.169.254). Nothing
  // legitimate reaches a provider over a translation prefix; refuse the space.
  if (a === 0x0064 && b === 0xff9b) return true; // NAT64 (64:ff9b::/32, incl. 64:ff9b:1::/48)
  if (a === 0x2002) return true; // 6to4 (embeds an IPv4)
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
      if (!isPublicPort(url.port)) {
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
      if (!res.ok) {
        // Same release as the 3xx branch above: a 4xx/5xx that carries a body
        // pins its socket outside the pool until GC, one per download attempt.
        await res.body?.cancel().catch(() => undefined);
        throw new Error(`download failed: ${res.status}`);
      }
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
  // Sniffed, not assumed: gpt returns PNG but the same path stores whatever a
  // gateway hands over, and the content type recorded here is what a PRESIGNED
  // url reports (the public API's image URLs, the external moderation detector).
  // A hardcoded image/png meant a WebP payload was advertised as PNG to everyone
  // except /api/files, which sniffs for itself.
  const type = storeContentType(buf, "image/png");
  const key = newStorageKey(extensionForContentType(type));
  await getStorage().put(key, buf, type);
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
