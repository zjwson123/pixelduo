process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://pixelduo:pixelduo@localhost:5432/pixelduo_test";

import { test, expect } from "@playwright/test";
import { prisma } from "../lib/prisma";

test("admin console: non-admin hidden, promoted user can adjust credits", async ({ page }) => {
  const email = `admin-${Date.now()}@test.dev`;
  const password = "password123";

  await page.goto("/register");
  await page.fill("#name", "Admin E2E");
  await page.fill("#email", email);
  await page.fill("#password", password);
  await page.click('button[type="submit"]');
  await page.waitForURL("**/studio");

  // Regular user: no Admin entry, /admin redirects away.
  await expect(page.locator('a[href="/admin"]')).toHaveCount(0);
  await page.goto("/admin");
  await page.waitForURL("**/studio");

  // Promote via DB, then the Admin entry appears and the console works.
  await prisma.user.update({ where: { email }, data: { role: "admin" } });
  await page.goto("/studio");
  await page.reload();
  await expect(page.locator('a[href="/admin"]')).toBeVisible();
  await page.locator('a[href="/admin"]').click();
  await page.waitForURL("**/admin");

  await expect(page.locator("h1", { hasText: "PixelDuo Admin" })).toBeVisible();
  const row = page.locator("table.ledger tbody tr", { hasText: email });
  await expect(row).toBeVisible();
  await expect(row.locator("td").nth(2)).toHaveText("30");

  // Grant +100 credits via the admin console.
  page.on("dialog", (d) => {
    if (d.type() === "prompt") {
      if (d.message().startsWith("Adjust credits")) d.accept("100");
      else if (d.message().startsWith("Reason")) d.accept("e2e compensation");
    }
  });
  await row.locator("button", { hasText: "Adjust" }).click();
  await expect(row.locator("td").nth(2)).toHaveText("130");
});
