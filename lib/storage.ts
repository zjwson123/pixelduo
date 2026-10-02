import fs from "fs";
import fsp from "fs/promises";
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
    await fsp.mkdir(path.dirname(f), { recursive: true });
    await fsp.writeFile(f, data);
  }

  async get(key: string): Promise<Buffer | null> {
    // Async read: a synchronous readFileSync of a large video blocks the
    // event loop for every concurrent request in the process.
    try {
      return await fsp.readFile(this.p(key));
    } catch {
      return null;
    }
  }

  async delete(key: string) {
    try {
      await fsp.unlink(this.p(key));
    } catch {
      // ignore missing
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
      await fsp.mkdir(this.root, { recursive: true });
      await fsp.writeFile(probe, String(Date.now()));
      await fsp.unlink(probe);
      return true;
    } catch {
      // Best effort: never leave a probe file behind, whatever failed.
      await fsp.unlink(probe).catch(() => undefined);
      return false;
    }
  }
}

class S3Storage implements StorageDriver {
  private client: S3Client;
  private bucket: string;

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
      requestHandler: {
        requestTimeout: outboundTimeoutMs(30_000),
        connectionTimeout: outboundTimeoutMs(5_000),
        socketTimeout: 60_000,
        throwOnRequestTimeout: true,
      },
    });
  }

  async put(key: string, data: Buffer, contentType = "image/png") {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data, ContentType: contentType }),
    );
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return Buffer.from(await r.Body!.transformToByteArray());
    } catch {
      return null;
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
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch {
      // ignore missing
    }
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

export function getStorage(): StorageDriver {
  if (driver) return driver;
  driver = (process.env.STORAGE_DRIVER ?? "local") === "s3" ? new S3Storage() : new LocalStorage();
  return driver;
}

export function newStorageKey(ext = "png"): string {
  return `img/${randomUUID()}.${ext}`;
}

// Best-effort delete of many objects with bounded concurrency. The erasure
// routes used to hand every key to one Promise.allSettled, so an account with
// tens of thousands of delivered rows queued that many DeleteObjectCommands into
// the driver at once (S3: all of them into undici's connection pool; local: the
// same number of concurrent fs operations) — a memory and socket spike on the
// one request an operator cannot ask the user to retry. Callers tolerate
// failures: the rows are what make content visible, so a blob that survives is
// an ops concern, not a user-facing one.
export async function deleteObjectsBounded(keys: string[], concurrency = 16): Promise<number> {
  const storage = getStorage();
  let deleted = 0;
  for (let i = 0; i < keys.length; i += concurrency) {
    const batch = keys.slice(i, i + concurrency);
    const results = await Promise.allSettled(batch.map((k) => storage.delete(k)));
    deleted += results.filter((r) => r.status === "fulfilled").length;
  }
  return deleted;
}

// Test hook
export function _resetStorageForTests() {
  driver = null;
}
