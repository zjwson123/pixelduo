process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://pixelduo:pixelduo@localhost:5432/pixelduo_test";

import fs from "fs";
import path from "path";
import { test, expect, type Page } from "@playwright/test";
import { prisma } from "../lib/prisma";

// The account and money lifecycle that mvp.spec.ts does not reach: credential
// rotation, refund/revocation through the webhook, plan entitlement, the data
// rights endpoints (export + erasure), daily check-in and the reference-image
// edit run. These are the paths where a regression costs money or leaks data,
// so they are exercised through the real HTTP surface against a production
// build — the unit tests already cover the library functions themselves.
//
// MAIL_DEV_DIR is required only by the reset test (it reads the emailed link
// the way a user would click it); everything else runs without it.

const mailDir = process.env.MAIL_DEV_DIR;

function mailLink(email: string, marker: string): string {
  const file = path.join(mailDir!, `${email}.txt`);
  const line = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .find((l) => l.includes(marker));
  if (!line) throw new Error(`no ${marker} link in mail: ${file}`);
  const url = line.match(/https?:\/\/\S+/)?.[0];
  if (!url) throw new Error(`no url in mail line: ${line}`);
  return url;
}

async function register(page: Page, email: string, password: string) {
  await page.goto("/register");
  await page.fill("#name", "Lifecycle");
  await page.fill("#email", email);
  await page.fill("#password", password);
  await page.click('button[type="submit"]');
  await page.waitForURL("**/studio");
  await expect(page.locator(".balance")).toContainText("30");
}

// An authenticated probe that spends nothing: the public API answers 400 for a
// body it cannot parse, but only AFTER the key authenticates — so 400 means the
// key works and 401 means it is dead.
async function v1Status(page: Page, key: string): Promise<number> {
  return page.evaluate(async (k) => {
    const r = await fetch("/api/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${k}` },
      body: JSON.stringify({}),
    });
    return r.status;
  }, key);
}

async function mintKey(page: Page, password: string): Promise<string> {
  const key = await page.evaluate(async (pw) => {
    const r = await fetch("/api/account/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "lifecycle-e2e", password: pw }),
    });
    return (await r.json()).key as string;
  }, password);
  expect(key.startsWith("pd_live_")).toBe(true);
  return key;
}

// The mock provider accepts a plain JSON event, so a refund can be delivered
// with the same shape a real provider's signed event arrives in.
async function fireRefund(page: Page, orderId: string, eventId: string) {
  return page.evaluate(
    async ([id, evt]) => {
      const r = await fetch("/api/webhooks/payment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventId: evt, orderId: id, status: "refunded" }),
      });
      return { status: r.status, body: await r.json() };
    },
    [orderId, eventId] as const,
  );
}

test("password reset: the emailed link rotates the credential and kills sessions + API keys", async ({ page }) => {
  test.skip(!mailDir, "requires MAIL_DEV_DIR so the emailed link can be read");
  const email = `lifecycle-reset-${Date.now()}@test.dev`;
  const oldPassword = "password123";
  const newPassword = "password456-new";
  await register(page, email, oldPassword);

  // A key minted while the old password was valid, and a live session, are both
  // credentials a hijacker could be holding — the reset has to kill both.
  const key = await mintKey(page, oldPassword);
  expect(await v1Status(page, key)).toBe(400);

  await page.locator("button", { hasText: "Sign out" }).click();
  await page.waitForResponse(
    (r) => r.url().includes("/api/auth/signout") && r.request().method() === "POST",
  );

  await page.goto("/forgot-password");
  await page.fill("#email", email);
  await page.click('button[type="submit"]');
  await expect(page.locator("p", { hasText: "a reset link is on its way" })).toBeVisible();

  // Follow the link from the mail, exactly as a user would.
  const link = mailLink(email, "/reset-password?token=");
  expect(link.startsWith(new URL(page.url()).origin)).toBe(true);
  await page.goto(link);
  await page.fill("#password", newPassword);
  await page.click('button[type="submit"]');
  await expect(page.locator("h1")).toContainText("Password updated");

  // The link is single-use.
  await page.goto(link);
  await page.fill("#password", "another-password");
  await page.click('button[type="submit"]');
  await expect(page.locator(".form-error")).toBeVisible();

  // The old password is dead, the new one works.
  await page.goto("/login");
  await page.fill("#email", email);
  await page.fill("#password", oldPassword);
  await page.click('button[type="submit"]');
  await expect(page.locator(".form-error")).toBeVisible();
  await page.fill("#password", newPassword);
  await page.click('button[type="submit"]');
  await page.waitForURL("**/studio");

  // And the key minted before the reset no longer authenticates.
  expect(await v1Status(page, key)).toBe(401);
});

test("refund webhook: credits are revoked once, replays are deduped, a late paid event cannot re-grant", async ({
  page,
}) => {
  const email = `lifecycle-refund-${Date.now()}@test.dev`;
  await register(page, email, "password123");

  // Buy a 1050-credit pack (mock fulfills inline, as the beta flow does).
  const checkout = await page.evaluate(async () => {
    const r = await fetch("/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "pack", itemId: "p2" }),
    });
    return { status: r.status, body: await r.json() };
  });
  expect(checkout.status).toBe(200);
  const orderId = checkout.body.orderId as string;
  await page.reload();
  await expect(page.locator(".balance")).toContainText("1080"); // 30 + 1050

  const refundEvent = `evt-refund-${Date.now()}`;
  const refund = await fireRefund(page, orderId, refundEvent);
  expect(refund.status).toBe(200);

  await page.reload();
  await expect(page.locator(".balance")).toContainText("30");
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  expect(order?.status).toBe("refunded");
  // The revocation is on the ledger, attributable to the order.
  const revoke = await prisma.ledgerEntry.findFirst({
    where: { refId: orderId, creditsDelta: { lt: 0 } },
  });
  expect(revoke).not.toBeNull();

  // The same event replayed is a no-op, not a second revocation.
  const replay = await fireRefund(page, orderId, refundEvent);
  expect(replay.body.duplicate).toBe(true);
  await page.reload();
  await expect(page.locator(".balance")).toContainText("30");

  // A paid event arriving after the refund (a retrying delivery, or an
  // attacker who captured one) must not restore the credits.
  const paidAfter = await page.evaluate(async (id) => {
    const r = await fetch("/api/webhooks/payment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventId: `evt-paid-late-${Date.now()}`, orderId: id, status: "paid" }),
    });
    return r.status;
  }, orderId);
  expect(paidAfter).toBe(200);
  await page.reload();
  await expect(page.locator(".balance")).toContainText("30");
  const after = await prisma.order.findUnique({ where: { id: orderId } });
  expect(after?.status).toBe("refunded");
});

test("plan checkout grants the tier, refunding it takes the tier back, and the free plan is not purchasable", async ({
  page,
}) => {
  const email = `lifecycle-plan-${Date.now()}@test.dev`;
  await register(page, email, "password123");

  const orderId = await page.evaluate(async () => {
    const r = await fetch("/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "plan", itemId: "pro" }),
    });
    return (await r.json()).orderId as string;
  });
  await page.reload();
  await expect(page.locator(".balance")).toContainText("2030"); // 30 + 2000
  const paid = await prisma.user.findUnique({ where: { email } });
  expect(paid?.plan).toBe("pro");
  expect(paid?.planRenewsAt).not.toBeNull();

  // Everything else is entitlement, so a refunded subscription must lose the
  // tier as well as the credits.
  await fireRefund(page, orderId, `evt-plan-refund-${Date.now()}`);
  const refunded = await prisma.user.findUnique({ where: { email } });
  expect(refunded?.plan).toBe("free");
  expect(refunded?.planRenewsAt).toBeNull();
  await page.reload();
  await expect(page.locator(".balance")).toContainText("30");

  // The free plan is a rejection, not an incident: 400, never 500.
  const freeStatus = await page.evaluate(async () => {
    const r = await fetch("/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "plan", itemId: "free" }),
    });
    return r.status;
  });
  expect(freeStatus).toBe(400);
});

test("data export: signed out it is refused, signed in it returns the caller's own records", async ({
  page,
  request,
}) => {
  const email = `lifecycle-export-${Date.now()}@test.dev`;
  const anon = await request.post("/api/account/export");
  expect(anon.status()).toBe(401);

  await register(page, email, "password123");
  const exported = await page.evaluate(async () => {
    const r = await fetch("/api/account/export", { method: "POST" });
    return { status: r.status, body: await r.json() };
  });
  expect(exported.status).toBe(200);
  expect(exported.body.data.user.email).toBe(email);
  // Not just non-empty: it is scoped to the caller. Another account's address
  // must not appear anywhere in the export.
  const blob = JSON.stringify(exported.body);
  const others = await prisma.user.findMany({
    where: { email: { not: email } },
    select: { email: true },
    take: 500,
  });
  const leaked = others.filter((u) => blob.includes(u.email));
  expect(leaked).toEqual([]);
});

test("account deletion requires the password, erases the account, and kills its credentials", async ({
  page,
}) => {
  const email = `lifecycle-delete-${Date.now()}@test.dev`;
  const password = "password123";
  await register(page, email, password);
  const key = await mintKey(page, password);

  // The confirmed-but-wrong-password path is a 400, and nothing is destroyed.
  const wrong = await page.evaluate(async () => {
    const r = await fetch("/api/account/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: true, password: "not-the-password" }),
    });
    return r.status;
  });
  expect(wrong).toBe(400);
  expect(await prisma.user.findUnique({ where: { email } })).not.toBeNull();

  const gone = await page.evaluate(async (pw) => {
    const r = await fetch("/api/account/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: true, password: pw }),
    });
    return { status: r.status, body: await r.json() };
  }, password);
  expect(gone.status).toBe(200);
  expect(gone.body.deleted).toBe(true);

  // Erased means erased: no row, no usable key, and the session is over.
  expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
  expect(await v1Status(page, key)).toBe(401);
  await page.goto("/studio");
  await page.waitForURL("**/login**");
});

test("daily check-in credits once per day", async ({ page }) => {
  const email = `lifecycle-checkin-${Date.now()}@test.dev`;
  await register(page, email, "password123");

  const first = await page.evaluate(async () => {
    const r = await fetch("/api/checkin", { method: "POST" });
    return { status: r.status, body: await r.json() };
  });
  expect(first.status).toBe(200);
  expect(first.body.balance).toBe(32); // 30 + 2

  const second = await page.evaluate(async () => {
    const r = await fetch("/api/checkin", { method: "POST" });
    return { status: r.status, body: await r.json() };
  });
  expect(second.status).toBe(200);
  expect(second.body.balance).toBe(32);
  const user = await prisma.user.findUnique({ where: { email } });
  expect(user?.credits).toBe(32);
});

test("edit: an uploaded reference image produces a result that stays private", async ({ page, request }) => {
  test.setTimeout(90_000);
  const email = `lifecycle-edit-${Date.now()}@test.dev`;
  await register(page, email, "password123");

  await page.locator("button.tab", { hasText: "Edit" }).click();
  // A 1x1 PNG is enough: the mock provider echoes a stub, and the point is the
  // upload → storage → job → result path.
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  await page.locator('input[type="file"]:not(#video-file-input)').setInputFiles({
    name: "reference.png",
    mimeType: "image/png",
    buffer: png,
  });
  await expect(page.locator(".upload-area img")).toBeVisible();
  await page.locator(".composer .prompt-box textarea").fill("make the mug blue");
  await page.locator("button.generate").click();
  await expect(page.locator(".result-card").first()).toBeVisible({ timeout: 30_000 });

  // The edited output is a private object: the URL must not be fetchable
  // without the owner's session.
  const src = await page.locator(".result-card img").first().getAttribute("src");
  expect(src).toBeTruthy();
  const anon = await request.get(new URL(src!, page.url()).pathname);
  expect(anon.status()).toBe(401);
});
