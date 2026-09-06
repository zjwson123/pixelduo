import { describe, expect, it } from "vitest";
import { ApiError, fail } from "../lib/api";

// Expected business errors must map to their proper 4xx status instead of a
// blanket 500, while unexpected errors stay masked as a generic 500.
async function statusOf(error: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = fail(error);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("fail() error classification", () => {
  it("preserves ApiError status codes", async () => {
    const { status, body } = await statusOf(new ApiError(403, "2fa-required"));
    expect(status).toBe(403);
    expect(body.error).toBe("2fa-required");
  });

  it("maps queue pressure to 429", async () => {
    const { status } = await statusOf(new Error("queue-full: max 5 concurrent jobs"));
    expect(status).toBe(429);
  });

  it("maps missing resources to 404 and conflicts to 409", async () => {
    expect((await statusOf(new Error("job-not-found"))).status).toBe(404);
    expect((await statusOf(new Error("email-already-registered"))).status).toBe(409);
  });

  it("maps auth/validation failures to 401/403/400", async () => {
    expect((await statusOf(new Error("invalid-password"))).status).toBe(400);
    expect((await statusOf(new Error("blocked:violence"))).status).toBe(400);
    expect((await statusOf(new Error("admin-required"))).status).toBe(403);
    expect((await statusOf(new Error("verify-email-required"))).status).toBe(403);
  });

  it("masks unexpected errors as a generic 500", async () => {
    const { status, body } = await statusOf(new Error("ECONNRESET at 10.0.0.5:5432"));
    expect(status).toBe(500);
    expect(body.error).toBe("internal-error");
  });

  it("treats a malformed JSON body as a 400", async () => {
    const { status, body } = await statusOf(new SyntaxError("Unexpected token < in JSON"));
    expect(status).toBe(400);
    expect(body.error).toBe("invalid-json");
  });
});
