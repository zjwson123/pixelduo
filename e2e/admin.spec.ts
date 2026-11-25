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

  // Pass 70: the role route's production surface through HTTP, not just a DB
  // write. A regular user cannot mint operator rights for anyone (including
  // themselves).
  const me = (await (await page.request.get("/api/me")).json()) as { user: { id: string } };
  const userId = me.user.id;
  const denied = await page.request.post(`/api/admin/users/${userId}/role`, {
    data: { role: "admin" },
  });
  expect(denied.status()).toBe(403);

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

  // Pass 70: the role route's refusals and its success path, end to end.
  const suffix = Date.now();
  const unverified = await prisma.user.create({
    data: { email: `unverified-${suffix}@test.dev`, passwordHash: "x".repeat(60) },
  });
  const verified = await prisma.user.create({
    data: {
      email: `promote-${suffix}@test.dev`,
      passwordHash: "x".repeat(60),
      emailVerified: new Date(),
    },
  });
  try {
    // Registration mints an account for any address before verification; an
    // unverified one must not receive operator rights.
    const unverifiedRes = await page.request.post(`/api/admin/users/${unverified.id}/role`, {
      data: { role: "admin" },
    });
    expect(unverifiedRes.status()).toBe(400);
    expect(((await unverifiedRes.json()) as { error: string }).error).toContain("cannot-promote-unverified");

    // The caller may not drop their own operator rights (the only in-app way
    // back would need host access).
    const selfDemote = await page.request.post(`/api/admin/users/${userId}/role`, {
      data: { role: "user" },
    });
    expect(selfDemote.status()).toBe(400);
    expect(((await selfDemote.json()) as { error: string }).error).toContain("cannot-demote-self");

    // A verified account can be promoted and demoted through the route.
    const promoted = await page.request.post(`/api/admin/users/${verified.id}/role`, {
      data: { role: "admin" },
    });
    expect(promoted.status()).toBe(200);
    expect(((await promoted.json()) as { user: { role: string } }).user.role).toBe("admin");
    const demoted = await page.request.post(`/api/admin/users/${verified.id}/role`, {
      data: { role: "user" },
    });
    expect(demoted.status()).toBe(200);
    expect(((await demoted.json()) as { user: { role: string } }).user.role).toBe("user");
  } finally {
    await prisma.user.deleteMany({ where: { id: { in: [unverified.id, verified.id] } } });
  }
});
