import { test, expect } from "@playwright/test";

test("API keys: create, call generations with the key, revoke", async ({ page }) => {
  const email = `apikey-${Date.now()}@test.dev`;
  const password = "password123";

  await page.goto("/register");
  await page.fill("#name", "API User");
  await page.fill("#email", email);
  await page.fill("#password", password);
  await page.click('button[type="submit"]');
  await page.waitForURL("**/studio");

  await page.goto("/account/api");
  await page.fill("#key-name", "e2e");
  await page.fill("#key-pw", password);
  await page.locator("button", { hasText: "Create key" }).click();
  const createdBox = page.locator(".api-key-banner");
  await expect(createdBox).toBeVisible();
  const key = (await createdBox.locator("code").innerText()).trim();
  expect(key.startsWith("pd_live_")).toBe(true);

  // Create a generation job with the key (worker is in mock mode).
  const created = await page.evaluate(async (k) => {
    const res = await fetch("/api/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${k}` },
      body: JSON.stringify({ prompt: "api test mug", model: "seedream", n: 1 }),
    });
    return res.json();
  }, key);
  expect(created.ok).toBe(true);
  expect(created.jobId).toBeTruthy();

  // Poll until done.
  const job = await page.evaluate(async ({ k, jobId }) => {
    for (let i = 0; i < 30; i++) {
      const res = await fetch(`/api/v1/images/generations/${jobId}`, {
        headers: { Authorization: `Bearer ${k}` },
      });
      const data = await res.json();
      if (data.job?.status === "done" || data.job?.status === "failed") return data.job;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return null;
  }, { k: key, jobId: created.jobId });
  expect(job?.status).toBe("done");
  expect(job?.images.length).toBe(1);

  // Revoke via UI → the key stops working.
  page.on("dialog", (d) => d.accept());
  await page.locator("button", { hasText: "Revoke" }).click();
  await expect(page.locator("td", { hasText: "revoked" })).toBeVisible();
  const afterRevoke = await page.evaluate(async (k) => {
    const res = await fetch("/api/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${k}` },
      body: JSON.stringify({ prompt: "blocked", model: "gpt", n: 1 }),
    });
    return { status: res.status };
  }, key);
  expect(afterRevoke.status).toBe(401);
});
