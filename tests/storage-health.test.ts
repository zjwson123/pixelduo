import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { getStorage, _resetStorageForTests } from "../lib/storage";

const origDriver = process.env.STORAGE_DRIVER;
const origDir = process.env.LOCAL_STORAGE_DIR;
let tmp: string;

describe("storage health", () => {
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pd-storage-health-"));
    process.env.STORAGE_DRIVER = "local";
    process.env.LOCAL_STORAGE_DIR = tmp;
    _resetStorageForTests();
  });

  afterAll(() => {
    if (origDriver) process.env.STORAGE_DRIVER = origDriver;
    else delete process.env.STORAGE_DRIVER;
    if (origDir) process.env.LOCAL_STORAGE_DIR = origDir;
    else delete process.env.LOCAL_STORAGE_DIR;
    _resetStorageForTests();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("local driver reports healthy when the directory is writable", async () => {
    expect(await getStorage().health()).toBe(true);
  });
});
