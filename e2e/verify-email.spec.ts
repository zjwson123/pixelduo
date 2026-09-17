import { readFileSync } from "fs";
import path from "path";
import { test, expect } from "@playwright/test";

// Requires the dev server to run with EMAIL_VERIFY_AUTO=0 and MAIL_DEV_DIR set
// (see README / local verification flow). Skipped in CI.
const mailDir = process.env.MAIL_DEV_DIR;
test.skip(!mailDir, "requires MAIL_DEV_DIR + EMAIL_VERIFY_AUTO=0");

function latestMailLink(email: string, marker: string): string {
  const file = path.join(mailDir!, `${email}.txt`);
  const text = readFileSync(file, "utf8");
  const line = text.split("\n").find((l) => l.includes(marker));
  if (!line) throw new Error(`no link in mail: ${file}`);
  const url = line.match(/https?:\/\/\S+/)?.[0];
  if (!url) throw new Error(`no url in mail line: ${line}`);
  return url;
}

test("register → blocked until verified → verify → 30 credits unlocked", async ({ page }) => {
  const email = `verify-${Date.now()}@test.dev`;
  const password = "password123";

  // 1. Register → pending verification screen (no credits yet)
  await page.goto("/register");
  await page.fill("#name", "Verify User");
  await page.fill("#email", email);
  await page.fill("#password", password);
  await page.click('button[type="submit"]');
  await expect(page.locator("h1", { hasText: "Check your inbox" })).toBeVisible();

  // 2. Sign in while unverified → banner shown, generation blocked
  await page.goto("/login");
  await page.fill("#email", email);
  await page.fill("#password", password);
  await page.click('button[type="submit"]');
  await page.waitForURL("**/studio");
  await expect(page.locator(".verify-banner")).toBeVisible();
  await page.locator("button.generate").click();
  await expect(page.locator(".toast")).toContainText("Verify your email first");
  await expect(page.locator(".balance")).toContainText("0");

  // 3. Click the verification link from the dev mail file. The page asks for the
  // password chosen at sign-up: the link proves control of the mailbox, the
  // password proves the registrant (see app/api/auth/verify-email/route.ts).
  const link = latestMailLink(email, "/verify-email?token=");
  await page.goto(link);
  await page.fill("#verify-pw", password);
  await page.click('button[type="submit"]');
  await expect(page.locator("h1", { hasText: "Email verified" })).toBeVisible();

  // 4. Back in the workbench: banner gone, 30 credits unlocked, generation works
  await page.goto("/login");
  await page.fill("#email", email);
  await page.fill("#password", password);
  await page.click('button[type="submit"]');
  await page.waitForURL("**/studio");
  await expect(page.locator(".verify-banner")).toHaveCount(0);
  await expect(page.locator(".balance")).toContainText("30");
  await page.locator(".composer .seg button", { hasText: "Seedream 5" }).click();
  await page.locator("button.generate").click();
  await expect(page.locator(".result-card").first()).toBeVisible({ timeout: 30000 });
});
