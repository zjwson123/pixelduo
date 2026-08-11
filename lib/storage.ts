import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export interface StorageDriver {
  put(key: string, data: Buffer, contentType?: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
  publicUrl(key: string): Promise<string>;
}

class LocalStorage implements StorageDriver {
  private root: string;

  constructor() {
    this.root = path.resolve(process.env.LOCAL_STORAGE_DIR ?? "data/files");
  }

  private p(key: string): string {
    const clean = key.replace(/^\/+/, "").split("/").filter(Boolean).join("/");
    return path.join(this.root, ...clean.split("/"));
  }

  async put(key: string, data: Buffer) {
    const f = this.p(key);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, data);
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return fs.readFileSync(this.p(key));
    } catch {
      return null;
    }
  }

  async delete(key: string) {
    try {
      fs.unlinkSync(this.p(key));
    } catch {
      // ignore missing
    }
  }

  async publicUrl(key: string): Promise<string> {
    return `/api/files/${key}`;
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

// Test hook
export function _resetStorageForTests() {
  driver = null;
}
