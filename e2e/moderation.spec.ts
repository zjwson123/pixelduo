// The two destructive media flows the suite did not cover end to end: a user
// deleting their own gallery items, and an operator removing someone else's
// delivered image from the console.
//
// Both are the place where a regression is invisible to the API: /api/files
// resolves an object through its Image row, so deleting the row but leaving the
// blob still answers 404 for the URL while the object survives in the bucket
// (the pass-53 ordering fix). With the local driver the test can look at the
// file itself; under any other driver it still pins the API half.
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://pixelduo:pixelduo@localhost:5432/pixelduo_test";

import fs from "node:fs";
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { prisma } from "../lib/prisma";

const BASE = process.env.PW_BASE_URL ?? "http://localhost:3100";
const PASSWORD = "password123";

// The local driver's root, as the APP sees it (same cwd: next start runs from
// the repo root in ci-local.sh and in CI's e2e job). Null when the suite runs
// against object storage, where a filesystem assertion is meaningless.
const localStorageDir =
  (process.env.STORAGE_DRIVER ?? "local") === "local"
    ? path.resolve(process.env.LOCAL_STORAGE_DIR ?? "data/files")
    : null;

function storedFile(key: string): string | null {
  return localStorageDir ? path.join(localStorageDir, key) : null;
}

async function register(page: Page, email: string) {
  await page.goto("/register");
  await page.fill("#name", "E2E Media");
  await page.fill("#email", email);
  await page.fill("#password", PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL("**/studio");
}

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.fill("#email", email);
  await page.fill("#password", PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL("**/studio");
}

// One image from the fast lane (Seedream, 6 credits). The result card appears
// only after completeJob committed, so the Image row exists when this returns.
async function generateOne(page: Page) {
  await page.locator(".composer .chip", { hasText: "Seedream 5" }).click();
  await page.locator("button.generate").click();
  await expect(page.locator(".result-card").first()).toBeVisible({ timeout: 30_000 });
}

interface GalleryImage {
  id: string;
  url: string;
}

async function gallery(page: Page): Promise<GalleryImage[]> {
  return page.evaluate(async () => {
    const r = await fetch("/api/gallery");
    const data = (await r.json()) as { images: GalleryImage[] };
    return data.images;
  });
}

function statusOf(page: Page, url: string): Promise<number> {
  return page.evaluate((u) => fetch(u).then((r) => r.status), url);
}

function deleteGallery(page: Page, ids: string[]) {
  return page.evaluate(async (list) => {
    const r = await fetch("/api/gallery", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: list }),
    });
    return { status: r.status, body: (await r.json()) as { ok: boolean; deleted: number; keptIds?: string[] } };
  }, ids);
}

test("gallery delete removes the stored object, and another account cannot delete it", async ({ browser, page }) => {
  const stamp = Date.now();
  const ownerEmail = `gal-owner-${stamp}@test.dev`;
  const otherEmail = `gal-other-${stamp}@test.dev`;

  await register(page, ownerEmail);
  await generateOne(page);
  const [img] = await gallery(page);
  expect(img).toBeTruthy();
  const key = img.url.replace("/api/files/", "");
  expect(key).not.toContain("/api/files/");
  // The delivered object really exists, through the route and on disk.
  expect(await statusOf(page, img.url)).toBe(200);
  const file = storedFile(key);
  if (file) expect(fs.existsSync(file)).toBe(true);

  // A second account must not be able to delete it: ownership lives in the
  // predicate, so the response is an ordinary "nothing matched".
  const otherCtx = await browser.newContext({ baseURL: BASE });
  const otherPage = await otherCtx.newPage();
  await register(otherPage, otherEmail);
  const foreign = await deleteGallery(otherPage, [img.id]);
  expect(foreign.status).toBe(200);
  expect(foreign.body.deleted).toBe(0);
  expect(await statusOf(page, img.url)).toBe(200);
  if (file) expect(fs.existsSync(file)).toBe(true);
  await otherCtx.close();

  // The owner's delete takes the object FIRST and the row with it.
  const own = await deleteGallery(page, [img.id]);
  expect(own.status).toBe(200);
  expect(own.body.deleted).toBe(1);
  expect(await statusOf(page, img.url)).toBe(404);
  if (file) expect(fs.existsSync(file)).toBe(false);
  expect(await gallery(page)).toHaveLength(0);
  // And the row is gone, not merely hidden.
  expect(await prisma.image.count({ where: { id: img.id } })).toBe(0);
});

test("moderation takedown: a non-admin is refused, an admin's delete removes the file for its owner", async ({
  browser,
  page,
}) => {
  const stamp = Date.now();
  const victimEmail = `tk-victim-${stamp}@test.dev`;
  const adminEmail = `tk-admin-${stamp}@test.dev`;

  await register(page, victimEmail);
  await generateOne(page);
  const [img] = await gallery(page);
  expect(img).toBeTruthy();
  const key = img.url.replace("/api/files/", "");
  expect(await statusOf(page, img.url)).toBe(200);
  const file = storedFile(key);
  if (file) expect(fs.existsSync(file)).toBe(true);

  const adminCtx = await browser.newContext({ baseURL: BASE });
  const adminPage = await adminCtx.newPage();
  await register(adminPage, adminEmail);

  const takedown = (p: Page) =>
    p.evaluate(async (id) => {
      const r = await fetch(`/api/admin/images/${id}`, { method: "DELETE" });
      return { status: r.status, body: (await r.json()) as { ok: boolean; deleted?: boolean; error?: string } };
    }, img.id);

  // Ordinary account: the guard, not a 404 and not a silent success.
  const refused = await takedown(adminPage);
  expect(refused.status).toBe(403);
  expect(refused.body.error).toBe("admin-required");
  expect(await statusOf(page, img.url)).toBe(200);
  if (file) expect(fs.existsSync(file)).toBe(true);

  // Promote out of band (the console route refuses to target the caller, and
  // this is the documented operator path's own effect), then the same request
  // is allowed and the delivered object leaves storage with the row.
  await prisma.user.update({ where: { email: adminEmail }, data: { role: "admin" } });
  const removed = await takedown(adminPage);
  expect(removed.status).toBe(200);
  expect(removed.body.deleted).toBe(true);

  expect(await statusOf(page, img.url)).toBe(404);
  if (file) expect(fs.existsSync(file)).toBe(false);
  expect(await gallery(page)).toHaveLength(0);
  expect(await prisma.image.count({ where: { id: img.id } })).toBe(0);

  // A second takedown of the same id is a clean 404, not a masked 500 (the
  // double-clicked-console shape pinned for the siblings).
  const again = await takedown(adminPage);
  expect(again.status).toBe(404);

  await adminCtx.close();
  await prisma.user.deleteMany({ where: { email: { in: [victimEmail, adminEmail] } } });
});
