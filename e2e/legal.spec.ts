import { test, expect } from "@playwright/test";

// The origin these requests actually address — NOT process.env.NEXTAUTH_URL.
//
// A Playwright worker is reused across spec files, and any spec that imports
// lib/prisma makes @prisma/client load the repository's .env into the worker
// process (probed: `require("@prisma/client")` sets NEXTAUTH_URL to the .env
// value). A worker that had already run such a spec therefore compared the
// served artifact against .env's port — `http://localhost:3000` — and failed a
// correct deployment on the very assertion that exists to catch a wrong origin
// (pass 40, seen as `Expected "…localhost:3000…"` while robots served :3100).
// The request URL is the ground truth here; PW_BASE_URL lets a run on another
// port say what that port is.
const APP_ORIGIN = process.env.PW_BASE_URL
  ? new URL(process.env.PW_BASE_URL).origin
  : "http://localhost:3100";

test("terms and privacy pages render with footer links", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("footer a", { hasText: "Terms" })).toBeVisible();
  await expect(page.locator("footer a", { hasText: "Privacy" })).toBeVisible();

  await page.goto("/terms");
  await expect(page.locator("h1", { hasText: "Terms of Service" })).toBeVisible();

  await page.goto("/privacy");
  await expect(page.locator("h1", { hasText: "Privacy Policy" })).toBeVisible();
});

test("robots and sitemap are published", async ({ request }) => {
  const robots = await request.get(`${APP_ORIGIN}/robots.txt`);
  expect(robots.status()).toBe(200);
  expect(await robots.text()).toContain("Sitemap:");

  const sitemap = await request.get(`${APP_ORIGIN}/sitemap.xml`);
  expect(sitemap.status()).toBe(200);
  expect(await sitemap.text()).toContain("<urlset");
});

test("robots and sitemap name the origin actually serving them", async ({ request }) => {
  // These two are prerendered at build time unless they say otherwise, and the
  // documented image build carries no NEXTAUTH_URL (.dockerignore excludes
  // `.env*`), so the shipped artifacts claimed http://localhost:3000: a sitemap
  // telling crawlers the canonical site is the builder's machine, which is
  // discarded rather than indexed. Asserting the served origin — not just that
  // the files exist — is the only way this shows up: the pages answer 200 either
  // way. The app under test runs on :3100 with NEXTAUTH_URL set to match.
  const robots = await (await request.get(`${APP_ORIGIN}/robots.txt`)).text();
  expect(robots).toContain(`Sitemap: ${APP_ORIGIN}/sitemap.xml`);
  expect(robots).not.toContain("localhost:3000");

  const sitemap = await (await request.get(`${APP_ORIGIN}/sitemap.xml`)).text();
  expect(sitemap).toContain(`<loc>${APP_ORIGIN}</loc>`);
  expect(sitemap).not.toContain("localhost:3000");
});

test("security headers are set on HTML responses", async ({ request }) => {
  const res = await request.get(`${APP_ORIGIN}/`);
  const headers = res.headers();
  expect(headers["content-security-policy"]).toContain("default-src 'self'");
  expect(headers["strict-transport-security"]).toBeTruthy();
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["x-frame-options"]).toBe("SAMEORIGIN");
});

test("landing language toggle switches to Chinese", async ({ page }) => {
  await page.goto("/");
  await page.locator("button", { hasText: "中文" }).click();
  await expect(page.locator(".hero-copy h1")).toContainText("一个提示词");
  await expect(page.locator(".land-links a", { hasText: "定价" })).toBeVisible();
});

test("landing FAQ and branded 404 render", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#faq summary", { hasText: "How is billing calculated?" })).toBeVisible();

  await page.goto("/this-page-does-not-exist");
  await expect(page.locator("h1", { hasText: "404" })).toBeVisible();
  await expect(page.locator("a", { hasText: "Back to home" })).toBeVisible();
});
