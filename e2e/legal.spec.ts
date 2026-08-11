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
