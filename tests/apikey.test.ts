import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../lib/prisma";
import { createApiKey, authenticateApiKey, revokeApiKey, hashApiKey } from "../lib/apikey";

let userId: string;

function bearer(key: string): Request {
  return new Request("http://localhost/api/v1/images/generations", {
    method: "POST",
    headers: { authorization: `Bearer ${key}` },
    body: JSON.stringify({ prompt: "test", model: "gpt", n: 1 }),
  });
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `apikey-${Date.now()}@test.dev`, passwordHash: "x", name: "API Key Test", emailVerified: new Date() },
  });
  userId = user.id;
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { startsWith: "apikey-" } } });
  await prisma.$disconnect();
});

describe("API keys", () => {
  it("creates a key and stores only the hash + prefix", async () => {
    const { key, prefix, id } = await createApiKey(userId, "prod");
    expect(key).toMatch(/^pd_live_[a-f0-9]{48}$/);
    expect(prefix).toBe(key.slice(0, "pd_live_".length + 4));
    const rec = await prisma.apiKey.findUniqueOrThrow({ where: { id } });
    expect(rec.keyHash).toBe(hashApiKey(key));
    expect(JSON.stringify(rec)).not.toContain(key);
  });

  it("authenticates valid keys and rejects missing/revoked ones", async () => {
    const { key, id } = await createApiKey(userId, "auth");
    const auth = await authenticateApiKey(bearer(key));
    expect(auth?.userId).toBe(userId);

    expect(await authenticateApiKey(new Request("http://localhost/x"))).toBeNull();
    expect(await authenticateApiKey(bearer("pd_live_garbage"))).toBeNull();

    expect(await revokeApiKey(userId, id)).toBe(true);
    expect(await revokeApiKey(userId, id)).toBe(false);
    expect(await authenticateApiKey(bearer(key))).toBeNull();
  });
});
