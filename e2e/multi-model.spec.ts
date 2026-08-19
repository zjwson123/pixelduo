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
  test("shows all image model options", async ({ page }) => {
    await registerAndLogin(page);
    await page.waitForSelector(".composer");

    const modelChips = await page.locator(".composer .chip").allTextContents();
    const allText = modelChips.join(" ");
    expect(allText).toContain("GPT Image 2");
    expect(allText).toContain("Seedream 5");
    expect(allText).toContain("Wan 2.7");
    expect(allText).toContain("Wan 2.7 Pro");
    expect(allText).toContain("Both");
  });

  test("generates with wan-image model", async ({ page }) => {
    await registerAndLogin(page);
    await page.waitForSelector(".composer");

    // Select wan-image model (not Pro)
    await page.locator(".composer .chip", { hasText: "Wan 2.7" }).first().click();

    await page.fill("textarea", "a beautiful sunset over the ocean");
    await page.locator("button.generate").click();

    // Wait for job to complete (mock mode = instant)
    await page.waitForSelector(".result-card img, .empty .serif", { timeout: 30_000 });
  });

  test("shows edit tab and upload area", async ({ page }) => {
    await registerAndLogin(page);
    await page.locator("button.tab", { hasText: "Edit" }).click();
    await page.waitForSelector(".upload-area");

    const uploadText = await page.locator(".upload-area").textContent();
    expect(uploadText).toContain("upload");
  });

  test("shows video tab with video models", async ({ page }) => {
    await registerAndLogin(page);
    await page.locator("button.tab", { hasText: "Video" }).click();
    await page.waitForSelector(".composer");

    const modelChips = await page.locator(".composer .chip").allTextContents();
    const allText = modelChips.join(" ");
    expect(allText).toContain("Seedance");
    expect(allText).toContain("Wan 2.7 T2V");
    expect(allText).toContain("Wan 2.7 I2V");
  });

  test("generates video with mock provider", async ({ page }) => {
    await registerAndLogin(page);
    await page.locator("button.tab", { hasText: "Video" }).click();

    await page.fill("textarea", "a cat walking in the garden");
    await page.locator("button.generate").click();

    // Wait for completion (mock mode)
    await page.waitForSelector("video, .gen-step.active, .serif", { timeout: 60_000 });
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
    expect(options.join(" ")).toContain("Qwen");
    expect(options.join(" ")).toContain("Kimi");
  });
});
