import { authenticator } from "otplib";
import { test, expect, type Page } from "@playwright/test";

// Sign out, wait for the session to be cleared server-side, then open the
// login page. signOut() redirects to the callbackUrl ("/") right after the
// response; on slow runners that redirect can race with (or fail before) our
// own navigation, so retry until the login form is actually reachable and
// stays put — this self-heals whichever way the race plays out.
async function signOutAndOpenLogin(page: Page, email: string, password: string) {
  await page.locator("button", { hasText: "Sign out" }).click();
  await page.waitForResponse(
    (r) => r.url().includes("/api/auth/signout") && r.request().method() === "POST",
  );
  await expect(async () => {
    await page.goto("/login");
    await expect(page.locator("#email")).toBeVisible({ timeout: 3000 });
    await expect(page).toHaveURL(/\/login$/, { timeout: 3000 });
  }).toPass({ timeout: 45_000 });
  await page.fill("#email", email);
  await page.fill("#password", password);
  await page.click('button[type="submit"]');
  await expect(page.locator("h1", { hasText: "Two-factor authentication" })).toBeVisible();
}

test("2FA: enable (password re-auth + global sign-out), TOTP login, backup code login", async ({ page }) => {
  // Multi-step auth flow; slow CI runners need headroom beyond the default 60s.
  test.setTimeout(120_000);
  const email = `2fa-${Date.now()}@test.dev`;
  const password = "password123";

  // 1. Register (auto-verified) and land in the workbench.
  await page.goto("/register");
  await page.fill("#name", "2FA User");
  await page.fill("#email", email);
  await page.fill("#password", password);
  await page.click('button[type="submit"]');
  await page.waitForURL("**/studio");

  // 2. Enable 2FA from the security page — now behind password re-auth.
  await page.goto("/account/security");
  await page.fill("#setup-pw", password);
  await page.locator("button", { hasText: "Enable 2FA" }).click();
  const secret = (await page.locator("code").innerText()).trim();
  await expect(page.locator("img[alt='TOTP QR code']")).toBeVisible();

  const totp = () => authenticator.generate(secret);
  await page.fill("#code", totp());
  await page.locator("button", { hasText: "Confirm & enable" }).click();
  await expect(page.locator("h2", { hasText: "Save your backup codes" })).toBeVisible();
  const backupCodes = await page.locator("code").allInnerTexts();
  expect(backupCodes).toHaveLength(10);
  // Enabling 2FA invalidates every pre-existing session — the enabling browser
  // included; the page says so and routes to sign-in.
  await expect(page.getByText("all other sessions were signed out", { exact: false })).toBeVisible();
  await page.locator("a", { hasText: "Go to sign-in" }).click();
  await expect(page.locator("#email")).toBeVisible();

  // 3. Sign in with password + live TOTP code.
  await page.fill("#email", email);
  await page.fill("#password", password);
  await page.click('button[type="submit"]');
  await expect(page.locator("h1", { hasText: "Two-factor authentication" })).toBeVisible();

  const meStatus = await page.evaluate(() => fetch("/api/me").then((r) => r.status));
  expect(meStatus).toBe(403); // partial session cannot touch protected APIs

  await page.fill("#code", totp());
  await page.locator("button", { hasText: "Verify" }).click();
  await page.waitForURL("**/studio");

  // 4. Sign out and log in again with a backup code.
  await signOutAndOpenLogin(page, email, password);
  await page.locator("button", { hasText: "Use a backup code instead" }).click();
  await page.fill("#code", backupCodes[0]);
  await page.locator("button", { hasText: "Verify" }).click();
  await page.waitForURL("**/studio");
});
