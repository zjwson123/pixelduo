import { test, expect } from "@playwright/test";

// Pass 36. The revocation claim (`sv`) was only enforced where session DATA is
// used (lib/api.ts) — never where the credential is READ. next-auth's
// /api/auth/session re-encodes whatever it decoded with a FRESH 30-day expiry,
// so a cookie the owner had just revoked kept answering with the account's
// identity and kept re-dating itself: "sign out all devices" left a permanent,
// self-renewing credential in the thief's hands (probed: /api/me → 401 while
// /api/auth/session → 200 with a new cookie on every call). This drives the
// real HTTP surface of a running instance rather than the callbacks directly.
test("a revoked session cookie has no identity at the session endpoint either", async ({ page }) => {
  test.setTimeout(90_000);
  const email = `revoke-${Date.now()}@test.dev`;
  const password = "password123";

  await page.goto("/register");
  await page.fill("#name", "Revoke User");
  await page.fill("#email", email);
  await page.fill("#password", password);
  await page.click('button[type="submit"]');
  await page.waitForURL("**/studio");

  const session = await page.request.get("/api/auth/session");
  expect(session.ok()).toBeTruthy();
  expect((await session.json()).user?.id).toBeTruthy();

  const revoke = await page.request.post("/api/auth/revoke-sessions");
  expect(revoke.ok(), await revoke.text()).toBeTruthy();

  // The guards refuse it (this already worked before pass 36)...
  expect((await page.request.get("/api/me")).status()).toBe(401);
  // ...and the credential is no longer a live one: the session endpoint must
  // not hand the account's identity back to it, which is what made the stolen
  // cookie worth keeping (and re-dating) forever.
  const after = await page.request.get("/api/auth/session");
  const body = await after.json();
  expect(body.user).toBeUndefined();
});
