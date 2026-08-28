import { test, expect } from "@playwright/test";

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
  const robots = await request.get("http://localhost:3100/robots.txt");
  expect(robots.status()).toBe(200);
  expect(await robots.text()).toContain("Sitemap:");

  const sitemap = await request.get("http://localhost:3100/sitemap.xml");
  expect(sitemap.status()).toBe(200);
  expect(await sitemap.text()).toContain("<urlset");
});

test("security headers are set on HTML responses", async ({ request }) => {
  const res = await request.get("http://localhost:3100/");
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
