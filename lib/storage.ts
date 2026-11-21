import fs from "fs";
import fsp from "fs/promises";
import http from "http";
import https from "https";
import path from "path";
import { randomUUID } from "crypto";
import { Readable } from "stream";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { outboundTimeoutMs } from "./runtime-env";

// The SDK's "no such key" shapes, and nothing else: a 404 from GetObject is a
// missing object whether it is spelled NoSuchKey, NotFound or only a status
// code (older gateways). Anything without a definite 404 — 403, 5xx, an aborted
// socket, a clock-skewed response — must propagate to the caller as a fault.
function isNotFoundError(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const err = e as {
    name?: unknown;
    Code?: unknown;
    code?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  const name = typeof err.name === "string" ? err.name : "";
  const code = typeof err.Code === "string" ? err.Code : typeof err.code === "string" ? err.code : "";
  if (name === "NoSuchKey" || name === "NotFound" || code === "NoSuchKey" || code === "NotFound") {
    return true;
  }
  return err.$metadata?.httpStatusCode === 404;
}

export interface StorageStream {
  stream: ReadableStream<Uint8Array>;
  /** Bytes this stream will yield (the range's length when one was asked for). */
  length?: number;
  /** Full object size, when the driver knows it. */
  total?: number;
}

/** A byte range for getStream, both ends inclusive, already validated. */
export interface ByteRange {
  start: number;
  end: number;
}

export interface StorageDriver {
  put(key: string, data: Buffer, contentType?: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  // Streaming variant for serving large objects (videos): get() materializes
  // the whole object in heap, so /api/files must not use it.
  getStream(key: string, range?: ByteRange): Promise<StorageStream | null>;
  /** Full object size, or null when the object is missing/unreadable. */
  size(key: string): Promise<number | null>;
  delete(key: string): Promise<void>;
  publicUrl(key: string): Promise<string>;
  health(): Promise<boolean>;
}

class LocalStorage implements StorageDriver {
  private root: string;

  constructor() {
    this.root = path.resolve(process.env.LOCAL_STORAGE_DIR ?? "data/files");
  }

  private p(key: string): string {
    // Strip leading slashes and resolve; reject any ".." segment to prevent
    // path traversal (e.g. /api/files/../../etc/passwd).
    const clean = key.replace(/^\/+/, "").split("/").filter(Boolean);
    if (clean.some((s) => s === "..")) throw new Error("invalid-key");
    const resolved = path.join(this.root, ...clean);
    // Defense in depth: ensure resolved path stays within root.
    const rel = path.relative(this.root, resolved);
    if (rel.startsWith("..")) throw new Error("invalid-key");
    return resolved;
  }

  async put(key: string, data: Buffer) {
    // Async: a synchronous write of a multi-MB reference image blocks the
    // event loop for every other request in the web container.
    const f = this.p(key);
    // Owner-only modes (pass 39). The default umask produced 0755 directories
    // and 0644 files, so on a host-run deployment using the local driver every
    // other local account could read every user's generated images and uploaded
    // reference photos — which the privacy policy calls private. Modes are set
    // explicitly rather than left to the umask (0700/0600 are unaffected by the
    // common 022), and existing trees are not rewritten.
    await fsp.mkdir(path.dirname(f), { recursive: true, mode: 0o700 });
    await fsp.writeFile(f, data, { mode: 0o600 });
  }

  async get(key: string): Promise<Buffer | null> {
    // Async read: a synchronous readFileSync of a large video blocks the
    // event loop for every concurrent request in the process.
    try {
      return await fsp.readFile(this.p(key));
    } catch (e) {
      // ONLY a genuinely absent object answers null (pass 66). Swallowing every
      // error made a transient read fault indistinguishable from "the file is
      // gone", and the worker treats null as proof: it fails the job as
      // `ref-image-missing` — a PERMANENT classification — and the terminal
      // branch then deletes the user's uploaded reference. One EACCES/ENOSPC/
      // EIO therefore destroyed a paid edit's input and refunded it as if the
      // customer had never uploaded anything.
      if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return null;
      throw e;
    }
  }

  async delete(key: string) {
    try {
      await fsp.unlink(this.p(key));
    } catch (e) {
      // Missing is success (delete is idempotent); anything else is a real
      // failure the erasure path must see (pass 39) — swallowing EACCES/ENOSPC
      // made "the account and its files are gone" a claim the code could not
      // evidence.
      if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") throw e;
    }
  }

  async getStream(key: string, range?: ByteRange): Promise<StorageStream | null> {
    try {
      const f = this.p(key);
      const stat = await fsp.stat(f);
      if (!stat.isFile()) return null;
      // createReadStream's end is inclusive, like the Range header it comes
      // from, so no off-by-one conversion here.
      return {
        stream: Readable.toWeb(
          fs.createReadStream(f, range ? { start: range.start, end: range.end } : undefined),
        ) as ReadableStream<Uint8Array>,
        length: range ? range.end - range.start + 1 : stat.size,
        total: stat.size,
      };
    } catch {
      return null;
    }
  }

  async size(key: string): Promise<number | null> {
    try {
      const stat = await fsp.stat(this.p(key));
      return stat.isFile() ? stat.size : null;
    } catch {
      return null;
    }
  }

  async publicUrl(key: string): Promise<string> {
    return `/api/files/${key}`;
  }

  async health(): Promise<boolean> {
    // Same async discipline as put/delete: this runs on every /api/health
    // probe, and three synchronous syscalls per probe (one of them a write)
    // stall every concurrent request in the process.
    //
    // The probe path is UNIQUE per call. It used to be one fixed `.health` file
    // written and unlinked by every probe, so two overlapping probes raced: the
    // loser's unlink threw ENOENT, the catch below turned that into `false`, and
    // the route answered 503 {"ok":false,"storage":"down"}. Overlap is easy to
    // produce — a burst on /api/health before the route's 5s cache is populated,
    // or two instances healthchecking one shared volume — and every consumer
    // reads only the STATUS (the compose healthcheck is `wget -qO-`, the CI wait
    // is `curl -fsS`, orchestrators and load balancers are the same), so a
    // concurrent probe could forge an outage and take a healthy instance out of
    // rotation or trip the on-call alert.
    const probe = path.join(this.root, `.health-${process.pid}-${randomUUID()}`);
    try {
      await fsp.mkdir(this.root, { recursive: true, mode: 0o700 });
      await fsp.writeFile(probe, String(Date.now()), { mode: 0o600 });
      await fsp.unlink(probe);
      return true;
    } catch {
      // Best effort: never leave a probe file behind, whatever failed.
      await fsp.unlink(probe).catch(() => undefined);
      return false;
    }
  }
}

// Sockets the S3 client may hold at once, for BOTH schemes. The SDK's default
// is 50 for the whole client, which was below the per-owner stream ceiling
// (lib/stream-limit.ts) and let one account pin the pool by opening streams and
// never reading them. The ceilings are now 128 per process and 64 per owner,
// and this pool sits above BOTH — so the stream caps are what binds and a
// saturated 128-stream process still leaves 64 sockets for the health probe,
// HeadObject and PUTs. A single owner can hold at most 64 of them. Exported so
// the relationship is asserted in tests instead of living in a comment.
export const S3_MAX_SOCKETS = 192;

class S3Storage implements StorageDriver {
  private client: S3Client;
  private bucket: string;

  // Total wall-clock budget for one object READ or WRITE body. Headers have
  // their own requestTimeout; this is what bounds a bucket that keeps the
  // connection alive but never finishes the body (see put()).
  private static readonly BODY_DEADLINE_MS = 300_000;

  constructor() {
    const endpoint = process.env.S3_ENDPOINT;
    this.bucket = process.env.S3_BUCKET ?? "";
    if (!this.bucket) throw new Error("S3_BUCKET is required when STORAGE_DRIVER=s3");
    this.client = new S3Client({
      region: process.env.S3_REGION ?? "us-east-1",
      endpoint: endpoint || undefined,
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "",
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "",
      },
      // Deadlines on every storage call. Both SDK defaults are 0 — INFINITE — so
      // a bucket that accepts the connection and then never answers (a network
      // drop, a paused container, a full TCP window) hung the caller for ever.
      // In the worker that is not a slow job, it is a stopped one: the 20s
      // heartbeat keeps firing while the promise hangs, so recoverStuckJobs
      // never reaps the job, the pre-auth is never refunded, the in-flight slot
      // stays held, and `await tick()` in the claim loop means NO job for ANY
      // user is claimed until somebody restarts the process. Measured against a
      // black-hole listener before the fix: put() and get() still pending at 25s.
      //
      // requestTimeout is time-to-response-headers (smithy clears it when the
      // response arrives), so it does not cut off a long /api/files download;
      // socketTimeout bounds a body that stops sending mid-stream, and
      // connectionTimeout bounds the TCP handshake. throwOnRequestTimeout is
      // required — without it smithy logs a warning and carries on. They belong
      // to the request HANDLER, not to the client config: S3ClientConfig has no
      // such fields, and an options object here is what NodeHttpHandler.create
      // accepts.
      //
      // The two agents exist for the same reason (pass 52): smithy's own
      // default agent is capped at maxSockets = 50, shared by every S3 call in
      // the process, while a `/api/files` stream holds one of those sockets for
      // as long as its consumer takes. Resolving the default pool above the
      // stream ceilings turns a single account's parked streams from a
      // deployment-wide outage into a bounded 429 for that account. keepAlive
      // matches the SDK default the explicit agent replaces; both schemes are
      // configured because S3_ENDPOINT may be http (MinIO) or https.
      requestHandler: {
        requestTimeout: outboundTimeoutMs(30_000),
        connectionTimeout: outboundTimeoutMs(5_000),
        socketTimeout: 60_000,
        throwOnRequestTimeout: true,
        httpAgent: new http.Agent({ keepAlive: true, maxSockets: S3_MAX_SOCKETS }),
        httpsAgent: new https.Agent({ keepAlive: true, maxSockets: S3_MAX_SOCKETS }),
      },
    });
  }

  async put(key: string, data: Buffer, contentType = "image/png") {
    // A TOTAL budget, not just an idle one (pass 39). requestTimeout stops at
    // the response headers and socketTimeout is reset by every chunk, so a
    // bucket trickling one byte per <60s held put/get — and therefore the
    // worker's single tick loop — indefinitely while the 20s heartbeat kept the
    // job looking alive to the reaper. 300s is generous for a same-region
    // object transfer and still bounded.
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data, ContentType: contentType }),
      { abortSignal: AbortSignal.timeout(S3Storage.BODY_DEADLINE_MS) },
    );
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      const r = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
        { abortSignal: AbortSignal.timeout(S3Storage.BODY_DEADLINE_MS) },
      );
      return Buffer.from(await r.Body!.transformToByteArray());
    } catch (e) {
      // Null means the object does not exist, and only that (pass 66). A 503,
      // a timeout or a throttled request used to answer the same null, and the
      // worker's ref-image path reads null as a permanently missing input: it
      // fails the job without retry and its terminal branch deletes the
      // customer's upload. Re-throwing keeps a transient fault transient (the
      // worker retries) and stops erasure/cleanup paths from acting on a
      // negative answer they never received.
      if (isNotFoundError(e)) return null;
      throw e;
    }
  }

  async getStream(key: string, range?: ByteRange): Promise<StorageStream | null> {
    try {
      const r = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
          // Ranged GET server-side: the alternative is downloading the whole
          // object to serve a 206, which is worse than not supporting Range.
          ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}),
        }),
      );
      if (!r.Body) return null;
      // A ranged response reports the range in Content-Range
      // ("bytes 100-199/2845909"); the total is only in that header, since
      // ContentLength is now the range's length.
      const total = r.ContentRange ? Number(r.ContentRange.split("/")[1]) : r.ContentLength;
      return {
        stream: Readable.toWeb(r.Body as Readable) as ReadableStream<Uint8Array>,
        length: r.ContentLength,
        total: Number.isFinite(total) ? total : undefined,
      };
    } catch {
      return null;
    }
  }

  async size(key: string): Promise<number | null> {
    try {
      // getStream would work, but this answers "how big is it" without opening
      // a body that then has to be cancelled.
      const r = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return typeof r.ContentLength === "number" ? r.ContentLength : null;
    } catch {
      return null;
    }
  }

  async delete(key: string) {
    // S3 DeleteObject is idempotent — a missing key is a 204, not an error —
    // so there is nothing to swallow. A network/permission failure must reach
    // the caller; the erasure routes use it to refuse claiming deletion of a
    // file that is still there (pass 39).
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async publicUrl(key: string): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: 3600 },
    );
  }

  async health(): Promise<boolean> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return true;
    } catch {
      return false;
    }
  }
}

let driver: StorageDriver | null = null;

// Which backend the deployment asked for, normalised and fail-closed.
//
// The old ternary was `(STORAGE_DRIVER ?? "local") === "s3" ? S3 : Local`, so
// every other spelling — "S3", "minio", "s3 " pasted from .env, a typo — silently
// selected LOCAL storage. In a container stack that means uploaded media and
// delivered outputs land on the container's ephemeral filesystem while
// /api/health still reports `storage: up` (the local probe writes a file), and
// every one of them is lost on redeploy while the Image/Job rows still point at
// them. A value this process does not recognise is a configuration error, not a
// reason to pick a backend the operator did not choose.
function storageDriverName(): "s3" | "local" {
  const raw = (process.env.STORAGE_DRIVER ?? "").trim().toLowerCase();
  if (raw === "" || raw === "local") return "local";
  if (raw === "s3") return "s3";
  throw new Error(
    `unknown STORAGE_DRIVER '${process.env.STORAGE_DRIVER}' — use 's3' or 'local' (the composes pin 's3'; a typo must not silently write to the container filesystem)`,
  );
}

export function getStorage(): StorageDriver {
  if (driver) return driver;
  driver = storageDriverName() === "s3" ? new S3Storage() : new LocalStorage();
  return driver;
}

export function newStorageKey(ext = "png"): string {
  return `img/${randomUUID()}.${ext}`;
}

// Bounded-concurrency delete of many objects. The erasure routes used to hand
// every key to one Promise.allSettled, so an account with tens of thousands of
// delivered rows queued that many DeleteObjectCommands into the driver at once
// (S3: all of them into undici's connection pool; local: the same number of
// concurrent fs operations) — a memory and socket spike on the one request an
// operator cannot ask the user to retry.
//
// Failures are reported, not just counted into a number the caller ignored
// (pass 39): erasure answers `{deleted:true}` only when every object it named
// was actually removed, so a transient bucket fault leaves the account intact
// and retryable instead of permanently orphaned. Other callers (gallery, admin
// takedown, worker reclaim) deliberately stay best-effort and use .catch().
export interface DeleteObjectsOutcome {
  deletedKeys: Set<string>;
  failed: number;
}

export async function deleteObjectsBounded(
  keys: string[],
  concurrency = 16,
): Promise<DeleteObjectsOutcome> {
  const storage = getStorage();
  const unique = [...new Set(keys)];
  const deletedKeys = new Set<string>();
  let failed = 0;
  for (let i = 0; i < unique.length; i += concurrency) {
    const batch = unique.slice(i, i + concurrency);
    const results = await Promise.allSettled(
      batch.map(async (k) => {
        await storage.delete(k);
        return k;
      }),
    );
    results.forEach((r, index) => {
      if (r.status === "fulfilled") deletedKeys.add(batch[index]);
      else failed += 1;
    });
  }
  return { deletedKeys, failed };
}

// Test hook
export function _resetStorageForTests() {
  driver = null;
}
