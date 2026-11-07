import { test, expect, request as pwRequest, type APIRequestContext } from "@playwright/test";

// Cross-account authorization and credit-invariant boundaries, driven through
// the real HTTP surface.
//
// The suite covered "a generated image requires a session" and the happy-path
// idempotency replay, but nothing proved that a *different signed-in account*
// cannot reach another account's media or jobs, nor that the client-key
// namespace stays per-operation end to end (tests/pass38 pins the library, not
// the two routes). Those are the boundaries where an ownership predicate
// dropped from a where-clause would silently become an IDOR, so they are
// asserted here against the built server.
const BASE = process.env.PW_BASE_URL ?? "http://localhost:3100";
const PASSWORD = "password123";

async function register(ctx: APIRequestContext, email: string) {
  const res = await ctx.post("/api/register", { data: { email, password: PASSWORD, name: "authz probe" } });
  expect(res.status(), await res.text()).toBe(200);
}

async function login(ctx: APIRequestContext, email: string) {
  const csrf = (await (await ctx.get("/api/auth/csrf")).json()) as { csrfToken: string };
  const res = await ctx.post("/api/auth/callback/credentials", {
    form: { csrfToken: csrf.csrfToken, email, password: PASSWORD, json: "true" },
  });
  expect(res.status(), await res.text()).toBe(200);
}

async function newUser(email: string): Promise<APIRequestContext> {
  const ctx = await pwRequest.newContext({ baseURL: BASE });
  await register(ctx, email);
  await login(ctx, email);
  return ctx;
}

async function waitForJob(ctx: APIRequestContext, id: string, timeoutMs = 45_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const res = await ctx.get(`/api/jobs/${id}`);
    expect(res.status()).toBe(200);
    const { job } = (await res.json()) as { job: { status: string; images: string[] } };
    if (job.status === "done" || job.status === "failed") return job;
    if (Date.now() > end) throw new Error(`job ${id} still ${job.status} after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1e6)}`;

test.describe("cross-account authorization", () => {
  test("generated media and job rows are owner-only, by session and by API key", async () => {
    test.setTimeout(90_000);
    const owner = await newUser(`authz-owner-${stamp()}@test.dev`);
    const other = await newUser(`authz-other-${stamp()}@test.dev`);
    const anon = await pwRequest.newContext({ baseURL: BASE });
    try {
      const gen = (await (
        await owner.post("/api/generate", {
          data: { prompt: "an ownership probe mug", model: "gpt", quality: "low", count: 1 },
        })
      ).json()) as { jobId: string };
      expect(gen.jobId).toBeTruthy();
      const job = await waitForJob(owner, gen.jobId);
      expect(job.status).toBe("done");
      const fileUrl = job.images[0];
      expect(fileUrl).toMatch(/^\/api\/files\//);

      expect((await owner.get(fileUrl)).status()).toBe(200);
      expect((await other.get(fileUrl)).status()).toBe(404);
      expect((await anon.get(fileUrl)).status()).toBe(401);
      // The job row is scoped the same way.
      expect((await other.get(`/api/jobs/${gen.jobId}`)).status()).toBe(404);

      // An API key is a credential for ITS account only: the same key that can
      // read the owner's own media is refused the other account's object.
      const minted = await other.post("/api/account/keys", { data: { name: "authz", password: PASSWORD } });
      expect(minted.status(), await minted.text()).toBe(200);
      const { key } = (await minted.json()) as { key: string };
      const bearer = { Authorization: `Bearer ${key}` };
      expect((await other.get(fileUrl, { headers: bearer })).status()).toBe(404);
      // ...and a fresh context with only that key (no cookie) is refused too.
      const keyOnly = await pwRequest.newContext({ baseURL: BASE, extraHTTPHeaders: bearer });
      expect((await keyOnly.get(fileUrl)).status()).toBe(404);
      await keyOnly.dispose();
    } finally {
      await owner.dispose();
      await other.dispose();
      await anon.dispose();
    }
  });

  test("one client key reused across generate and edit names two different jobs", async () => {
    test.setTimeout(60_000);
    const owner = await newUser(`authz-idem-${stamp()}@test.dev`);
    try {
      const key = `authz-cross-${stamp()}`;
      const gen = (await (
        await owner.post("/api/generate", {
          data: { prompt: "cross route probe", model: "gpt", quality: "low", count: 1, idempotencyKey: key },
        })
      ).json()) as { jobId: string; duplicate: boolean };
      expect(gen.jobId).toBeTruthy();

      // 1x1 PNG — enough to reach the edit lane.
      const png =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
      const editRes = await owner.post("/api/edit", {
        data: {
          prompt: "cross route edit",
          model: "gpt",
          quality: "low",
          image: `data:image/png;base64,${png}`,
          idempotencyKey: key,
        },
      });
      const edit = (await editRes.json()) as { jobId: string; duplicate: boolean };
      expect(editRes.status(), JSON.stringify(edit)).toBe(200);
      expect(edit.jobId).not.toBe(gen.jobId);
      expect(edit.duplicate).toBe(false);
    } finally {
      await owner.dispose();
    }
  });

  test("another account's finished video cannot be extended", async () => {
    test.setTimeout(120_000);
    const owner = await newUser(`authz-video-${stamp()}@test.dev`);
    const other = await newUser(`authz-video-b-${stamp()}@test.dev`);
    try {
      // A pack funds the video: the signup bonus alone is below the segment price.
      const paid = await owner.post("/api/checkout", { data: { kind: "pack", itemId: "p1" } });
      expect(paid.status(), await paid.text()).toBe(200);
      expect(((await paid.json()) as { status: string }).status).toBe("paid");

      const created = await owner.post("/api/video", {
        data: { prompt: "a short ownership probe clip", model: "seedance", duration: 4 },
      });
      const { jobId } = (await created.json()) as { jobId: string };
      expect(jobId, await created.text()).toBeTruthy();
      const job = await waitForJob(owner, jobId);
      expect(job.status).toBe("done");

      const extend = await other.post("/api/video", {
        data: { prompt: "extend someone else's clip", model: "seedance", duration: 4, extendOf: jobId },
      });
      expect(extend.status()).toBe(400);
      expect(await extend.text()).toContain("extendOf");

      expect((await other.get(job.images[0])).status()).toBe(404);
      expect((await owner.fetch(job.images[0], { method: "HEAD" })).status()).toBe(200);
    } finally {
      await owner.dispose();
      await other.dispose();
    }
  });

  test("concurrent check-ins grant exactly one daily credit", async () => {
    const owner = await newUser(`authz-checkin-${stamp()}@test.dev`);
    try {
      const before = ((await (await owner.get("/api/me")).json()) as { user: { credits: number } }).user.credits;
      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          owner.post("/api/checkin").then((r) => r.json() as Promise<{ claimed: boolean }>),
        ),
      );
      expect(results.filter((r) => r.claimed)).toHaveLength(1);
      const after = ((await (await owner.get("/api/me")).json()) as { user: { credits: number } }).user.credits;
      expect(after - before).toBe(2);
    } finally {
      await owner.dispose();
    }
  });
});
