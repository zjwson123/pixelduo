process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://pixelduo:pixelduo@localhost:5432/pixelduo_test";

import { test, expect } from "@playwright/test";
import { prisma } from "../lib/prisma";

// A message long enough for the schema (min 10 chars) and specific enough to
// find again in the database.
function messageFor(tag: string): string {
  return `e2e feedback ${tag} — the export button does nothing on Firefox, steps: open the ledger, click export.`;
}

test("landing footer links to a feedback page anyone can use", async ({ page }) => {
  await page.goto("/");
  await page.locator("footer.land-footer a", { hasText: "Feedback" }).click();
  await page.waitForURL(/\/feedback(\?|$)/);

  await expect(page.locator("h1", { hasText: "Say something" })).toBeVisible();
  // Signed out: the form must ask for an address to reply to.
  await expect(page.locator("#feedback-email")).toBeVisible();
  await expect(page.locator("#feedback-message")).toBeVisible();
  // The category choices are the shared vocabulary, not free text.
  await expect(page.locator(".chips .chip", { hasText: "Something's broken" })).toBeVisible();

  // Bilingual like the rest of the product.
  await page.locator(".auth-card button", { hasText: "中文" }).click();
  await expect(page.locator("h1", { hasText: "留言反馈" })).toBeVisible();
  await expect(page.locator(".chips .chip", { hasText: "遇到问题" })).toBeVisible();
});

test("a signed-out visitor can send a report, and it reaches the operator inbox", async ({ page }) => {
  const tag = `anon-${Date.now()}`;
  const email = `${tag}@test.dev`;

  await page.goto("/");
  await page.locator("footer.land-footer a", { hasText: "Feedback" }).click();
  await page.waitForURL(/\/feedback(\?|$)/);

  await page.locator(".chips .chip", { hasText: "Something's broken" }).click();
  await page.fill("#feedback-message", messageFor(tag));
  await page.fill("#feedback-email", email);
  await page.locator('button[type="submit"]').click();

  // Calm confirmation with a reference the sender can quote.
  await expect(page.locator("h1", { hasText: "Received." })).toBeVisible();
  await expect(page.locator(".auth-card .sub")).toContainText(email);
  await expect(page.locator(".auth-card .sub")).toContainText(/#[a-z0-9]{6,}/i);

  const row = await prisma.feedback.findFirstOrThrow({ where: { email } });
  expect(row.userId).toBeNull();
  expect(row.category).toBe("bug");
  expect(row.message).toContain(tag);
  // The context an operator needs to reproduce, captured without asking.
  expect(row.page).toBe("/");
  expect(row.status).toBe("new");

  await prisma.feedback.deleteMany({ where: { email } });
});

test("a signed-in report carries the account, and the admin inbox can close it", async ({ page }) => {
  const tag = `member-${Date.now()}`;
  const email = `${tag}@test.dev`;
  const password = "password123";

  await page.goto("/register");
  await page.fill("#name", "Feedback E2E");
  await page.fill("#email", email);
  await page.fill("#password", password);
  await page.click('button[type="submit"]');
  await page.waitForURL("**/studio");

  // Reachable from the workbench too, and signed in it asks for no address:
  // the account's own (verified) mailbox is the reply channel.
  await page.locator('a[href^="/feedback"]').first().click();
  await page.waitForURL(/\/feedback(\?|$)/);
  await expect(page.locator("#feedback-email")).toHaveCount(0);
  await expect(page.locator(".auth-card")).toContainText(email);

  await page.locator(".chips .chip", { hasText: "Billing" }).click();
  await page.fill("#feedback-message", messageFor(tag));
  await page.locator('button[type="submit"]').click();
  await expect(page.locator("h1", { hasText: "Received." })).toBeVisible();

  const row = await prisma.feedback.findFirstOrThrow({ where: { email } });
  expect(row.category).toBe("billing");
  expect(row.page).toBe("/studio");
  expect(row.userId).not.toBeNull();
  expect(row.plan).toBe("free");

  // Promote this account and read the message in the console.
  await prisma.user.update({ where: { email }, data: { role: "admin" } });
  await page.goto("/studio");
  await page.reload();
  await page.locator('a[href="/admin"]').click();
  await page.waitForURL("**/admin");
  await page.locator("button", { hasText: /^feedback/ }).click();

  const card = page.locator(".card", { hasText: tag });
  await expect(card).toBeVisible();
  await expect(card).toContainText(email);
  await expect(card).toContainText("billing");

  await card.locator("button", { hasText: "Mark handled" }).click();
  // The default view is the unhandled queue, so closing it removes the card.
  await expect(page.locator(".card", { hasText: tag })).toHaveCount(0);
  const closed = await prisma.feedback.findUniqueOrThrow({ where: { id: row.id } });
  expect(closed.status).toBe("done");
  expect(closed.handledBy).not.toBeNull();

  await prisma.feedback.deleteMany({ where: { email } });
});
