import { test, expect } from "@playwright/test";

test("MVP end-to-end: register → generate → template → checkout → ledger", async ({ page }) => {
  const email = `e2e-${Date.now()}@test.dev`;
  const password = "password123";

  // 1. Register → 30 free credits
  await page.goto("/register");
  await page.fill("#name", "E2E User");
  await page.fill("#email", email);
  await page.fill("#password", password);
  await page.click('button[type="submit"]');
  await page.waitForURL("**/studio");
  await expect(page.locator(".balance")).toContainText("30");

  // 2. Generate with Seedream (fast path) → balance 30 - 6 = 24
  await page.locator(".composer .chip", { hasText: "Seedream 5" }).click();
  await page.locator("button.generate").click();
  await expect(page.locator(".result-card").first()).toBeVisible({ timeout: 30000 });
  await expect(page.locator(".balance")).toContainText("24");

  // 3. Template reuse
  await page.locator("button.tab", { hasText: "Explore" }).click();
  await expect(page.locator(".tmpl-card").first()).toBeVisible();
  await page.locator(".tmpl-card").first().click();
  await expect(page.locator("button.tab", { hasText: "Create" })).toHaveClass(/active/);

  // 4. Pricing → pack checkout (mock) → balance 24 + 1050 = 1074
  await page.locator("button.tab", { hasText: "Pricing" }).click();
  await page.locator("button.pack", { hasText: "$9.99" }).click();
  await expect(page.locator(".modal")).toBeVisible();
  await page.locator(".modal button.btn-dark", { hasText: "Confirm" }).click();
  await expect(page.locator(".toast")).toContainText("Beta mock paid");
  await expect(page.locator(".balance")).toContainText("1074");

  // 5. Ledger shows transparent movements
  await page.locator("button.tab", { hasText: "Ledger" }).click();
  await expect(page.locator("table.ledger")).toBeVisible();
  const rows = page.locator("table.ledger tbody tr");
  await expect(rows.first()).toBeVisible();
  const text = await rows.allInnerTexts();
  const joined = text.join("\n");
  expect(joined).toContain("Signup bonus");
  expect(joined).toContain("Credit pack");

  // 6. Orders API returns the paid purchase
  const orders = await page.evaluate(async () => {
    const r = await fetch("/api/orders");
    return r.json();
  });
  expect(orders.ok).toBe(true);
  expect(orders.orders.length).toBeGreaterThanOrEqual(1);
  expect(orders.orders.some((o: { kind: string; status: string }) => o.kind === "pack" && o.status === "paid")).toBe(true);

  // 7. Orders tab renders the purchase
  await page.locator("button.tab", { hasText: "Orders" }).click();
  await expect(page.locator("table.ledger tbody")).toContainText("1050 credits pack");
  await expect(page.locator("table.ledger tbody")).toContainText("Paid");
});

test("idempotency: same key never double-charges", async ({ page }) => {
  const email = `idem-${Date.now()}@test.dev`;
  const password = "password123";
  await page.goto("/register");
  await page.fill("#name", "Idem");
  await page.fill("#email", email);
  await page.fill("#password", password);
  await page.click('button[type="submit"]');
  await page.waitForURL("**/studio");
  await expect(page.locator(".balance")).toContainText("30");

  const key = crypto.randomUUID();
  const first = await page.evaluate(async (k) => {
    const r = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "idempotent test mug", model: "seedream", quality: "medium", count: 1, idempotencyKey: k }),
    });
    return r.json();
  }, key);
  const second = await page.evaluate(async (k) => {
    const r = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "idempotent test mug", model: "seedream", quality: "medium", count: 1, idempotencyKey: k }),
    });
    return r.json();
  }, key);
  expect(first.jobId).toBe(second.jobId);
  expect(second.duplicate).toBe(true);
  await page.reload();
  await expect(page.locator(".balance")).toContainText("24"); // charged once
});

test("generated images require auth", async ({ page }) => {
  const res = await page.request.get("http://localhost:3100/api/files/img/does-not-exist.png");
  expect(res.status()).toBe(401);
});

test("health endpoint reports ok", async ({ request }) => {
  const res = await request.get("http://localhost:3100/api/health");
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(body.db).toBe("up");
  expect(body.redis).toBe("up");
  expect(body.storage).toBe("up");
  expect(typeof body.queue.queued).toBe("number");
});
