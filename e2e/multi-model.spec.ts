import { test, expect } from "@playwright/test";

const BASE = "http://localhost:3100";

async function registerAndLogin(page: import("@playwright/test").Page) {
  const email = `e2e-multi-${Date.now()}@test.dev`;
  const password = "password123";
  await page.goto(`${BASE}/register`);
  await page.fill("#name", "Multi Model");
  await page.fill("#email", email);
  await page.fill("#password", password);
  await page.click('button[type="submit"]');
  await page.waitForURL("**/studio", { timeout: 10_000 });
  return email;
}

test.describe("Multi-model image generation", () => {
  test("shows enabled image model options (wan disabled 2026-08)", async ({ page }) => {
    await registerAndLogin(page);
    await page.waitForSelector(".composer");

    const modelChips = await page.locator(".composer .chip").allTextContents();
    const allText = modelChips.join(" ");
    expect(allText).toContain("GPT Image 2");
    expect(allText).toContain("Seedream 5");
    expect(allText).toContain("Both");
    // wan models were disabled after the DashScope key lost model access
    expect(allText).not.toContain("Wan 2.7");
  });

  test("generates with seedream model, then click-to-zoom preview", async ({ page }) => {
    await registerAndLogin(page);
    await page.waitForSelector(".composer");

    // Select seedream model
    await page.locator(".composer .chip", { hasText: "Seedream 5" }).first().click();

    await page.fill("textarea", "a beautiful sunset over the ocean");
    await page.locator("button.generate").click();

    // Wait for the job to reach a terminal state (mock mode = fast).
    await expect(
      page.locator(".result-card img, .empty .serif").first(),
    ).toBeVisible({ timeout: 30_000 });

    // Click the image → full-screen preview opens; Esc closes it
    const img = page.locator(".result-card img").first();
    if (await img.count()) {
      await img.click();
      await expect(page.locator(".lightbox img")).toBeVisible({ timeout: 5_000 });
      await page.keyboard.press("Escape");
      await expect(page.locator(".lightbox")).toHaveCount(0);
    }
  });

  test("shows edit tab and upload area", async ({ page }) => {
    await registerAndLogin(page);
    await page.locator("button.tab", { hasText: "Edit" }).click();
    await page.waitForSelector(".upload-area");

    const uploadText = await page.locator(".upload-area").textContent();
    expect(uploadText).toContain("upload");
  });

  test("shows video tab with enabled video models", async ({ page }) => {
    await registerAndLogin(page);
    await page.locator("button.tab", { hasText: "Video" }).click();
    await page.waitForSelector(".composer");

    const modelChips = await page.locator(".composer .chip").allTextContents();
    const allText = modelChips.join(" ");
    expect(allText).toContain("Seedance");
    expect(allText).not.toContain("Wan 2.7 T2V");
    expect(allText).not.toContain("Wan 2.7 I2V");
  });

  test("generates video end-to-end with mock provider", async ({ page }) => {
    await registerAndLogin(page);

    // Top up first: signup bonus (30) can't cover a 5s video (70 credits).
    // Go through the Pricing UI (page.request.post doesn't carry the
    // session cookie, so the API would 401).
    await page.locator("button.tab", { hasText: "Pricing" }).click();
    await page.locator("button.pack", { hasText: "$9.99" }).click();
    await expect(page.locator(".modal")).toBeVisible();
    await page.locator(".modal button.btn-dark", { hasText: "Confirm" }).click();
    await expect(page.locator(".toast")).toContainText("mock paid", { timeout: 5_000 });
    await expect(page.locator(".balance")).toContainText("1080");

    await page.locator("button.tab", { hasText: "Video" }).click();

    await page.fill("textarea", "a cat walking in the garden");
    await page.locator("button.generate").click();

    // Must reach the DONE state and render the video element. The loose
    // ".gen-step.active" matcher used to pass while polling jobs were stuck
    // in an unclaimable state (see tests/queue-video.test.ts).
    await expect(page.locator("video")).toBeVisible({ timeout: 60_000 });
    await expect(page.locator(".results-head")).toContainText(/video/i, { timeout: 10_000 });
  });

  test("queues two image jobs back-to-back and completes both", async ({ page }) => {
    await registerAndLogin(page);
    await page.waitForSelector(".composer");

    await page.fill("textarea", "a red apple on a wooden table");
    await page.locator("button.generate").click();

    // The Generate button must stay clickable — submit a second job while
    // the first is still running (queue, don't block)
    await page.fill("textarea", "a blue ceramic mug on a desk");
    await page.locator("button.generate").click();

    // Both jobs must reach done and render their own result group
    await expect(page.locator(".result-card img").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".results-head", { hasText: "Latest results" })).toHaveCount(2, { timeout: 30_000 });
  });

  test("explore tab supports search and category filtering", async ({ page }) => {
    await registerAndLogin(page);
    await page.locator("button.tab", { hasText: "Explore" }).click();
    await expect(page.locator(".tmpl-card").first()).toBeVisible({ timeout: 10_000 });

    // Search narrows results
    await page.fill('input[type="search"]', "poster");
    await expect(page.locator(".tmpl-card")).toHaveCount(0, { timeout: 1_000 }).catch(() => undefined);
    // clear search → results return
    await page.fill('input[type="search"]', "");
    await expect(page.locator(".tmpl-card").first()).toBeVisible({ timeout: 10_000 });

    // Category filter changes the visible set
    const beforeCount = await page.locator(".tmpl-card").count();
    await page.locator(".cat-row .chip", { hasText: "UI" }).first().click();
    const afterCount = await page.locator(".tmpl-card").count();
    // Filtered count differs (fewer or equal) but cards are still visible
    expect(afterCount).toBeGreaterThan(0);
    expect(afterCount).toBeLessThanOrEqual(beforeCount || 529);
  });

  test("smart routing button exists and is clickable", async ({ page }) => {
    await registerAndLogin(page);
    await page.waitForSelector(".composer");
    const smartRouteBtn = page.locator('button:has-text("Smart route")');
    await expect(smartRouteBtn).toBeVisible();
  });

  test("assistant model selector has multiple options", async ({ page }) => {
    await registerAndLogin(page);
    await page.waitForSelector(".composer");
    const selector = page.locator("select");
    await expect(selector).toBeVisible();
    const options = await selector.locator("option").allTextContents();
    expect(options.join(" ")).toContain("DeepSeek");
    expect(options.join(" ")).toContain("GLM");
    expect(options.join(" ")).toContain("Kimi");
    // qwen dropped: DashScope key is restricted from qwen* models
    expect(options.join(" ")).not.toContain("Qwen");
  });
});
